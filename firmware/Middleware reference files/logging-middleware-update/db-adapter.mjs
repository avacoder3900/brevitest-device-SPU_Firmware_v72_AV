/**
 * db-adapter.mjs — Dual-source database adapter for Lambda middleware.
 *
 * Tries MongoDB first (unified collection names), falls back to CouchDB.
 * MongoDB uses the unified collection names from DOMAIN-08-UNIFY:
 *   - assay_definitions  (was: assays)
 *   - cartridge_records   (was: cartridges)
 *
 * LOGGING UPDATE:
 *   - Added BIMS API forwarding for device logs, crashes, webhook logs, and events
 *   - saveDeviceLog(), saveDeviceCrash(), saveWebhookLog(), saveDeviceEvent() POST to BIMS API
 *   - BIMS owns all logging collection writes (nanoid IDs, immutable middleware, Mongoose validation)
 *   - Requires BIMS_API_URL and BIMS_API_KEY env vars
 *
 * NOTE: mongodb is loaded via dynamic import() so the Lambda doesn't crash
 * if the mongodb package has resolution issues or MONGODB_URI is not set.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MONGODB_URI = process.env.MONGODB_URI ?? '';
const MONGODB_DB = process.env.MONGODB_DB ?? 'bioscale';
const COUCHDB_BASEURL = process.env.COUCHDB_BASEURL ?? '';
const COUCHDB_CREDENTIAL = process.env.COUCHDB_BASE64_CREDENTIAL ?? '';

/** Map schema names to unified MongoDB collection names. */
const COLLECTION_FOR_SCHEMA = {
    cartridge: 'cartridge_records',
    assay: 'assay_definitions',
    device: 'devices',
    user: 'users',
    log: 'logs',
    experiment: 'experiments',
    site: 'sites'
};

const collectionForSchema = (schema) => {
    return COLLECTION_FOR_SCHEMA[schema] ?? schema;
};

// ---------------------------------------------------------------------------
// MongoDB helpers — dynamic import, lazy connection
// ---------------------------------------------------------------------------

let _mongoClient = null;
let _MongoClient = null;

const getMongoClient = async () => {
    if (!MONGODB_URI) return null;
    try {
        if (!_mongoClient) {
            if (!_MongoClient) {
                const mongodb = await import('mongodb');
                _MongoClient = mongodb.MongoClient;
            }
            _mongoClient = new _MongoClient(MONGODB_URI);
            await _mongoClient.connect();
            console.log('db-adapter: Connected to MongoDB');
        }
        return _mongoClient;
    } catch (err) {
        console.error('db-adapter: MongoDB connection failed, falling back to CouchDB:', err.message);
        return null;
    }
};

const getMongoDb = async () => {
    const client = await getMongoClient();
    return client ? client.db(MONGODB_DB) : null;
};

// ---------------------------------------------------------------------------
// CouchDB helpers (unchanged from original Lambda)
// ---------------------------------------------------------------------------

const couchHeaders = () => {
    const headers = new Headers();
    headers.append('Authorization', `Basic ${COUCHDB_CREDENTIAL}`);
    return headers;
};

const couchLoadById = async (docId, db) => {
    try {
        const options = { method: 'GET', headers: couchHeaders() };
        const response = await fetch(`${COUCHDB_BASEURL}/${db}/${docId}`, options);
        const data = await response.json();
        return response.status === 200 ? data : null;
    } catch (err) {
        console.error(`db-adapter: CouchDB load failed for ${db}/${docId}:`, err.message);
        return null;
    }
};

const couchSave = async (doc, db) => {
    try {
        const options = {
            method: 'PUT',
            headers: couchHeaders(),
            body: JSON.stringify(doc)
        };
        const response = await fetch(`${COUCHDB_BASEURL}/${db}/${doc._id}`, options);
        const data = await response.json();
        return response.status === 201 ? { ...doc, _rev: data.rev } : null;
    } catch (err) {
        console.error(`db-adapter: CouchDB save failed for ${db}/${doc._id}:`, err.message);
        return null;
    }
};

// ---------------------------------------------------------------------------
// Public API — loadAssayById
// ---------------------------------------------------------------------------

/**
 * Load an assay by _id.
 * Queries the `assay_definitions` collection in MongoDB, falls back to CouchDB.
 */
const loadAssayById = async (assayId, couchDb) => {
    // Try MongoDB
    const mongoDb = await getMongoDb();
    if (mongoDb) {
        try {
            const doc = await mongoDb.collection('assay_definitions').findOne({ _id: assayId });
            if (doc) return doc;
        } catch (err) {
            console.error('db-adapter: MongoDB assay lookup failed:', err.message);
        }
    }

    // Fall back to CouchDB
    return couchLoadById(assayId, couchDb ?? 'research');
};

// ---------------------------------------------------------------------------
// Public API — loadCartridgeById
// ---------------------------------------------------------------------------

/**
 * Load a cartridge by _id (barcode).
 * Queries the `cartridge_records` collection in MongoDB, falls back to CouchDB
 * search across multiple databases (research, bioscale, c0000000, fabrication).
 */
const loadCartridgeById = async (barcode) => {
    // Try MongoDB
    const mongoDb = await getMongoDb();
    if (mongoDb) {
        try {
            const doc = await mongoDb.collection('cartridge_records').findOne({ _id: barcode });
            if (doc) return doc;
        } catch (err) {
            console.error('db-adapter: MongoDB cartridge lookup failed:', err.message);
        }
    }

    // Fall back to CouchDB — search across known databases
    const couchDatabases = ['research', 'bioscale', 'c0000000', 'fabrication'];
    for (const db of couchDatabases) {
        const data = await couchLoadById(barcode, db);
        if (data) return data;
    }
    return null;
};

// ---------------------------------------------------------------------------
// Public API — saveDocument
// ---------------------------------------------------------------------------

/**
 * Save (create or update) a document.
 * If MONGODB_URI is set and document has a schema, writes to MongoDB too.
 * Always writes to CouchDB for backward compatibility during migration.
 */
const saveDocument = async (doc, db) => {
    let savedDoc = null;

    // Determine MongoDB collection: use schema field if present, otherwise infer from doc shape
    const schema = doc.schema
        || (doc.assayId !== undefined ? 'cartridge' : null)
        || (doc.BCODE !== undefined ? 'assay' : null);

    // Write to MongoDB if available
    const mongoDb = await getMongoDb();
    if (mongoDb && schema) {
        try {
            const collection = collectionForSchema(schema);
            const docCopy = { ...doc };
            delete docCopy._rev; // MongoDB doesn't use _rev
            await mongoDb.collection(collection).updateOne(
                { _id: doc._id },
                { $set: docCopy },
                { upsert: true }
            );
            savedDoc = doc;
        } catch (err) {
            console.error('db-adapter: MongoDB save failed:', err.message);
        }
    }

    // Write to CouchDB if doc has _rev (exists in CouchDB) or schema (CouchDB-origin)
    if (doc._rev || doc.schema) {
        const couchResult = await couchSave(doc, db);
        if (couchResult) {
            savedDoc = couchResult;
        }
    }

    return savedDoc;
};

// ---------------------------------------------------------------------------
// Public API — BIMS API Forwarding
// ---------------------------------------------------------------------------
//
// Instead of writing directly to MongoDB logging collections, the middleware
// forwards parsed log/crash/webhook data to the BIMS API. This lets the BIMS
// own all writes (nanoid IDs, immutable middleware, Mongoose validation).
//
// Requires env vars:
//   BIMS_API_URL  — e.g., "https://your-bims.vercel.app"
//   BIMS_API_KEY  — must match the BIMS AGENT_API_KEY
// ---------------------------------------------------------------------------

const BIMS_API_URL = process.env.BIMS_API_URL ?? '';
const BIMS_API_KEY = process.env.BIMS_API_KEY ?? '';

/**
 * POST JSON to a BIMS API endpoint. Returns the parsed response body or null on failure.
 * Best-effort — failures are logged but never break the caller.
 */
const postToBims = async (path, body) => {
    if (!BIMS_API_URL) {
        console.warn('db-adapter: BIMS_API_URL not set — skipping BIMS forward for', path);
        return null;
    }
    try {
        const url = `${BIMS_API_URL}${path}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': BIMS_API_KEY
            },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            const text = await response.text();
            console.error(`db-adapter: BIMS ${path} returned ${response.status}:`, text);
            return null;
        }
        const data = await response.json();
        console.log(`db-adapter: BIMS ${path} success`, data);
        return data;
    } catch (err) {
        console.error(`db-adapter: BIMS ${path} failed:`, err.message);
        return null;
    }
};

/**
 * Forward a parsed device session log to the BIMS API.
 * BIMS creates the DeviceLog document with nanoid _id and immutable middleware.
 */
const saveDeviceLog = async (logDoc) => {
    return postToBims('/api/device/logs', logDoc);
};

/**
 * Forward a crash report to the BIMS API.
 * BIMS creates the DeviceCrash document.
 */
const saveDeviceCrash = async (crashDoc) => {
    return postToBims('/api/device/crashes', crashDoc);
};

/**
 * Forward an enhanced webhook log to the BIMS API.
 * BIMS creates the WebhookLog document.
 */
const saveWebhookLog = async (webhookLogDoc) => {
    return postToBims('/api/device/webhook-logs', webhookLogDoc);
};

/**
 * Forward an archived Particle event to the BIMS API.
 * BIMS creates or updates the DeviceEvent document.
 */
const saveDeviceEvent = async (eventDoc) => {
    return postToBims('/api/device/events', eventDoc);
};

// ---------------------------------------------------------------------------
// Public API — closeConnection
// ---------------------------------------------------------------------------

const closeConnection = async () => {
    if (_mongoClient) {
        await _mongoClient.close();
        _mongoClient = null;
    }
};

export default {
    collectionForSchema,
    loadAssayById,
    loadCartridgeById,
    saveDocument,
    saveDeviceLog,
    saveDeviceCrash,
    saveWebhookLog,
    saveDeviceEvent,
    closeConnection
};

export {
    collectionForSchema,
    loadAssayById,
    loadCartridgeById,
    saveDocument,
    saveDeviceLog,
    saveDeviceCrash,
    saveWebhookLog,
    saveDeviceEvent,
    closeConnection
};
