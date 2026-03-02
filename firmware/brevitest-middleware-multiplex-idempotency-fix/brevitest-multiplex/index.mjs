import util from './utilities.mjs';
import evaluate from './evaluate.mjs';

const ARG_DELIM = ',';
const ATTR_DELIM = ':';
const ITEM_DELIM = '|';
const END_DELIM = "#";

const saveDocument = async (doc, db) => {
    try {
        const headers = new Headers();
        headers.append('Authorization', `Basic ${process.env.COUCHDB_BASE64_CREDENTIAL}`);
        const options = { method: 'PUT', headers, body: JSON.stringify(doc) };
        console.log('saveDocument', db, doc._id, doc.schema, options);
        const response = await fetch(`${process.env.COUCHDB_BASEURL}/${doc.siteId}/${doc._id}`, options);
        const data = await response.json();
        return response.status === 201 ? { ...doc, _rev: data.rev } : null;
    } catch (error) {
        throw new Error(error);
    }
};

const getDevice = async (deviceId) => {
    try {
        const headers = new Headers();
        headers.append('Authorization', `Bearer ${process.env.PARTICLE_ACCESS_TOKEN}`);
        const options = { method: 'GET', headers };
        const url = `${process.env.PARTICLE_URL}/devices/${deviceId}`;
        const response = await fetch(url, options);
        console.log('getDevice', deviceId, response);
        if (response.status === 200) {
            const device = await response.json();
            console.log('Device', device);
            return device;
        } else if (response.status === 404) {
            throw new Error(`Device ${docId} not found!`);
        } else {
            return null;
        }
    } catch (error) {
        throw new Error(error);
    }
};

const loadDocumentById = async (docId, db) => {
    const headers = new Headers();
    headers.append('Authorization', `Basic ${process.env.COUCHDB_BASE64_CREDENTIAL}`);
    const options = { method: 'GET', headers };
    console.log('getDocument', db, docId);
    const response = await fetch(`${process.env.COUCHDB_BASEURL}/${db}/${docId}`, options);
    const data = await response.json();
    return response.status === 200 ? data : null;
};

const loadCartridgeById = async (barcode) => {
    let data;
    data = await loadDocumentById(barcode, 'research');
    if (!data) {
        data = await loadDocumentById(barcode, 'bioscale');
        if (!data) {
            data = await loadDocumentById(barcode, 'c0000000');
            if (!data) {
                data = await loadDocumentById(barcode, 'fabrication');
            }
        }
    };
    return data;
};

const bcodeCommands = [{
    num: '0',
    name: 'START TEST',
    params: [],
    description: 'Starts the test. Required to be the first command. Test executes until Finish Test command.'
}, {
    num: '1',
    name: 'DELAY',
    params: ['delay_ms'],
    description: 'Waits for specified number of milliseconds.'
}, {
    num: '2',
    name: 'MOVE MICRONS',
    params: ['microns', 'step_delay_us'],
    description: 'Moves the stage a specified number of microns at a specified speed expressed as a step delay in microseconds.'
}, {
    num: '3',
    name: 'OSCILLATE STAGE',
    params: ['microns', 'step_delay_us', 'cycles'],
    description: 'Oscillates back and forth a given distance at a specified speed expressed as a step delay in microseconds.'
}, {
    num: '10',
    name: 'SET SENSOR PARAMS',
    params: ['gain', 'step', 'time'],
    description: 'Set sensor parameters.'
}, {
    num: '11',
    name: 'READ BASELINE',
    params: ['scans'],
    description: 'Read sensors with number of samples.'
}, {
    num: '14',
    name: 'READ TEST',
    params: ['scans'],
    description: 'Read sensors with number of samples.'
}, {
    num: '15',
    name: 'READ SENSOR',
    params: ['channel', 'gain', 'step', 'time'],
    description: 'Raw sensor read.'
}, {
    num: '20',
    name: 'REPEAT',
    params: ['count'],
    description: 'Repeats the block of BCODE.'
}, {
    num: '98',
    name: 'COMMENT',
    params: ['text'],
    description: 'Comment - ignored by system.'
}, {
    num: '99',
    name: 'FINISH TEST',
    params: [],
    description: 'Finishes the test. Required to be the final command.'
}];

const getBcodeCommand = (command) => {
    return bcodeCommands.find(e => e.name === command);
};

const instructionTime = (command, params) => {
    // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
    switch (command) {
        case 'DELAY': // delay
            return parseInt(params.delay_ms, 10);
        case 'MOVE MICRONS': // move microns
            return Math.floor(2 * Math.abs(parseInt(params.microns, 10)) * parseInt(params.step_delay_us, 10) / 25000);
        case 'OSCILLATE STAGE': // oscillate
            return Math.floor(4 * parseInt(params.cycles, 10) * Math.abs(parseInt(params.microns, 10)) * parseInt(params.step_delay_us, 10) / 25000);
        case 'READ BASELINE': // read baseline
        case 'READ TEST':
        case 'READ SENSOR':
            return 5000;
        case 'START TEST': // startup sequence
            return 9000;
        case 'FINISH TEST': // cleanup sequence
            return 8000;
    }
    // jscs:enable requireCamelCaseOrUpperCaseIdentifiers
    return 0;
};

const bcodeDuration = (bcodeArray) => {
    const total_duration = bcodeArray.reduce((duration, bcode) => {
        const cmd = bcode.command.toUpperCase();
        if (cmd === 'REPEAT') {
            return duration + bcodeDuration(bcode.code) * parseInt(bcode.count, 10);
        } else {
            return duration + instructionTime(cmd, bcode.params);
        }
    }, 0);

    return parseInt(total_duration, 10);
};

const compileInstruction = (cmd, args) => {
    const command = getBcodeCommand(cmd);
    const keys = Object.keys(args);
    const argKeys = keys.length ? keys.filter(k => k.toLowerCase() !== 'comment') : [];  // remove comments
    if (command.params.length !== argKeys.length) {
        throw new Error(`Parameter count mismatch, command: ${cmd} should have ${command.params.length}, has ${argKeys.length}`);
    }
    if (command.params.length) {
        return command.params.reduce((result, param) => `${result}${ARG_DELIM}${args[param]}`, command.num) + ATTR_DELIM;
    } else {
        return command.num + ATTR_DELIM;
    }
};

const compileRepeatBegin = (count) => {
    return `20,${count}${ATTR_DELIM}`;
};

const compileRepeatEnd = () => {
    return `21${ATTR_DELIM}`;
};

const bcodeCompile = (bcodeArray) => {
    return bcodeArray.reduce((compiledCode, bcode) => {
        const cmd = bcode.command.toUpperCase();
        if (cmd === 'COMMENT') {
            return compiledCode;
        } else if (cmd === 'REPEAT') {
            return compiledCode + compileRepeatBegin(bcode.count) + bcodeCompile(bcode.code) + compileRepeatEnd();
        } else {
            return compiledCode + compileInstruction(cmd, bcode.params);
        }
    }, '');
};

const load_assay = async (device, body) => {
    let response;
    const data = {};
    try {
        console.log('body', body);
        const data = JSON.parse(body.data);
        const assayId = data?.assay_id ?? '';
        console.log('load_assay', assayId);
        if (!assayId) {
            response = await send_response(assayId, 'load-assay', 'FAILURE', { errorMessage: `Assay ID missing` });
        } else {
            const assay = await loadDocumentById(assayId, 'research');
            if (!assay) {
                throw new Error(`Error reading assay ${assayId}`);
            }
            data.bcode = bcodeCompile(assay.BCODE.code);
            data.duration = parseInt(bcodeDuration(assay.BCODE.code) / 1000, 10);
            data.assayId = assayId;
            data.checksum = util.checksum(data.bcode);
            response = await send_response(device.id, 'load-assay', 'SUCCESS', data);
        }
    } catch (error) {
        if (error.message) {
            response = await send_response(device.id, 'load-assay', 'FAILURE', { errorMessage: error.message });
        } else {
            response = await send_response(device.id, 'load-assay', 'ERROR', { errorMessage: device.id });
        }
    }
    return response;
};

// ══════════════════════════════════════════════════════════════
// IDEMPOTENCY FIX: validate_cartridge
//
// Problem: If the device retries after a timeout, the cartridge
// is already marked as used/underway from the first call.
// Without idempotency, the retry would fail with "already used"
// or "not linked".
//
// Fix: Detect that cartridge is already 'underway' for THIS
// device, load the assay, and return the same SUCCESS response.
// Also echo requestId in ALL response paths.
// ══════════════════════════════════════════════════════════════
const validate_cartridge = async (device, body) => {
    let response;
    let cartridgeId = '';
    let requestId = '';
    try {
        const data = JSON.parse(body.data);
        console.log('validate_cartridge', data);
        cartridgeId = data?.uuid ?? '';
        requestId = data?.requestId ?? '';
        if (!cartridgeId) {
            throw new Error(`FAILURE: Cartridge ID is missing.`);
        }

        const today = new Date();
        const cartridge = await loadCartridgeById(cartridgeId);
        console.log('today', today, cartridge && cartridge.expirationDate);
        if (!cartridge) {
            throw new Error(`Cartridge ${cartridgeId} missing, may be deleted`);
        }

        // ══════════════════════════════════════════════
        // IDEMPOTENCY CHECK - Must come BEFORE status validation
        // If cartridge is already 'underway' for THIS device, this is a retry.
        // Load the assay and return the same SUCCESS response.
        // ══════════════════════════════════════════════
        if (cartridge.status === 'underway' &&
            cartridge.used === true &&
            cartridge.device?.id === device.id) {

            console.log(`Idempotent retry detected for cartridge ${cartridgeId} on device ${device.id}`);

            // Load the assay BEFORE referencing it
            const assayId = cartridge.assayId;
            const assay = await loadDocumentById(assayId, cartridge.siteId === 'research' ? 'research' : 'admin');
            if (!assay) {
                throw new Error(`Error reading assay ${assayId} during idempotent retry`);
            }

            // Return the same SUCCESS response the original request would have returned
            const checksum = util.checksum(bcodeCompile(assay.BCODE.code));
            response = await send_response(device.id, 'validate-cartridge', 'SUCCESS', { cartridgeId, assayId, checksum, requestId });
            return response;
        }

        // ══════════════════════════════════════════════
        // NORMAL VALIDATION (first-time request)
        // ══════════════════════════════════════════════
        if (cartridge.used) {
            throw new Error(`Cartridge ${cartridgeId} already used`);
        } else if (new Date(cartridge.expirationDate) < today) {
            throw new Error(`Cartridge ${cartridgeId} is expired`);
        } else if (cartridge.status !== 'linked') {
            throw new Error(`Cartridge ${cartridgeId} is not linked`);
        }
        const assayId = cartridge.assayId;
        const assay = await loadDocumentById(assayId, cartridge.siteId === 'research' ? 'research' : 'admin');
        if (!assay) {
            throw new Error(`Error reading assay ${assayId}`);
        }
        const when = new Date().toISOString();
        const who = 'brevitest-cloud';
        const where = { city_name: 'Houston' };
        cartridge.device = device;
        cartridge.assay = assay;
        cartridge.assay.duration = parseInt(bcodeDuration(assay.BCODE.code) / 1000, 10);
        cartridge.status = 'underway';
        cartridge.used = true;
        cartridge.checkpoints.underway = { when, who, where };
        cartridge.statusUpdatedOn = when;
        await saveDocument(cartridge, cartridge.siteId);
        const checksum = util.checksum(bcodeCompile(assay.BCODE.code));
        response = await send_response(device.id, 'validate-cartridge', 'SUCCESS', { cartridgeId, assayId, checksum, requestId });
    } catch (error) {
        if (error.message) {
            response = await send_response(device.id, 'validate-cartridge', 'FAILURE', { errorMessage: error.message, cartridgeId, requestId });
        } else {
            response = await send_response(device.id, 'validate-cartridge', 'ERROR', { errorMessage: error, cartridgeId, requestId });
        }
    }
    return response;
};

// ══════════════════════════════════════════════════════════════
// IDEMPOTENCY FIX: reset_cartridge
//
// Problem: If the device retries after a timeout, the cartridge
// may already be reset to 'linked' status. The retry would fail
// with "status is not underway or cancelled".
//
// Fix: If cartridge is already 'linked', return SUCCESS immediately.
// ══════════════════════════════════════════════════════════════
const reset_cartridge = async (device, body) => {
    let response;
    let cartridgeId = '';
    let requestId = '';
    try {
        const data = JSON.parse(body.data);
        console.log('reset_cartridge', data);
        cartridgeId = data?.uuid ?? '';
        requestId = data?.requestId ?? '';
        if (!cartridgeId) {
            throw new Error(`FAILURE: Cartridge ID is missing.`);
        }

        const cartridge = await loadCartridgeById(cartridgeId);

        // ══════════════════════════════════════════════
        // IDEMPOTENCY CHECK - If already reset, return SUCCESS
        // ══════════════════════════════════════════════
        if (cartridge.status === 'linked') {
            console.log(`Idempotent retry detected for reset_cartridge ${cartridgeId} - already linked`);
            response = await send_response(device.id, 'reset-cartridge', 'SUCCESS', { cartridgeId, requestId });
            return response;
        }

        // ══════════════════════════════════════════════
        // NORMAL RESET (first-time request)
        // ══════════════════════════════════════════════
        if (!(cartridge.status === 'underway' || cartridge.status === 'cancelled')) {
            throw new Error(`FAILURE: Cartridge status is not underway or cancelled.`);
        }
        cartridge.status = 'linked';
        cartridge.statusUpdatedOn = new Date().toISOString();
        delete cartridge.used;
        delete cartridge.device;
        delete cartridge.assay;
        delete cartridge.day;
        delete cartridge.checkpoints.underway;
        delete cartridge.rawData;
        delete cartridge.validationErrors;
        delete cartridge.readouts;
        delete cartridge.reading;
        delete cartridge.result;
        delete cartridge.referenceRange;
        const updatedCartridge = await saveDocument(cartridge, cartridge.siteId);
        console.log('updatedCartridge', updatedCartridge);
        response = await send_response(device.id, 'reset-cartridge', 'SUCCESS', { cartridgeId, requestId });
    } catch (error) {
        if (error.message) {
            response = await send_response(device.id, 'reset-cartridge', 'FAILURE', { errorMessage: error.message, cartridgeId, requestId });
        } else {
            response = await send_response(device.id, 'reset-cartridge', 'ERROR', { errorMessage: error, cartridgeId, requestId });
        }
    }
    return response;
};

const mutableAttrs = [
    'name',
    'readouts',
    'validationErrors',
    'result',
    'reading',
    'referenceRange',
    'day',
    'hour'
];

const frequencies = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir'];
const parseReading = (byteArray, offset) => {
    const result = {
        number: byteArray.readUint8(offset),
        channel: byteArray.slice(offset + 1, offset + 2).toString(),
        position: byteArray.readUint16LE(offset + 2),
        temperature: byteArray.readUint16LE(offset + 4),
        laser_output: byteArray.readUint16LE(offset + 6),
        msec: byteArray.readUint32LE(offset + 8)
    }
    frequencies.forEach((f, ii) => {
        result[f] = byteArray.readUint16LE(offset + 12 + (2 * ii))
    })
    return result;
}

const readingSort = (a, b) => a.number - b.number;
const parseByteArray = (byteArray) => {
    const result = {
        dataFormat: byteArray.slice(0, 1).toString(),
        cartridgeId: byteArray.slice(1, 37).toString(),
        assayId: byteArray.slice(38, 46).toString(),
        startTime: byteArray.readUint32LE(48),
        duration: byteArray.readUint16LE(52),
        astep: byteArray.readUint16LE(54),
        atime: byteArray.readUint8(56),
        again: byteArray.readUint8(57),
        numberOfReadings: byteArray.readUint16LE(58),
        baselineScans: byteArray.readUint16LE(60),
        testScans: byteArray.readUint16LE(62),
        checksum: byteArray.readUint32LE(64),
    };
    console.log('byteArray result', result);
    result.readings = Array.from({ length: result.numberOfReadings }, (_, i) => parseReading(byteArray, 68 + (i * 32))).sort(readingSort);
    return result;
}

const parsePayload = (body) => {
    const headerLength = 'data:application/octet-stream;base64,'.length;
    const byteArray = Buffer.from(body.data.slice(headerLength), 'base64');
    const result = parseByteArray(byteArray);
    return result;
}

// ══════════════════════════════════════════════════════════════
// IDEMPOTENCY FIX: test_upload
//
// Problem: If the device retries after a timeout, the cartridge
// already has status 'completed'/'cancelled' with rawData saved.
// Without idempotency, the retry would overwrite data and re-run
// evaluate(), risking CouchDB _rev conflicts.
//
// Fix: Detect that cartridge already has results from THIS device,
// and return the same response without re-processing.
// ══════════════════════════════════════════════════════════════
const test_upload = async (device, body) => {
    let response;
    try {
        // await write_log(device.id, 'upload-test', 'PENDING', body.data);
        const result = parsePayload(body);
        if (!result.cartridgeId) {
            throw new Error(`FAILURE: Cartridge ID uploaded in device ${device.id} is missing.`);
        }
        const cartridgeId = result.cartridgeId;
        const cartridge = await loadCartridgeById(result.cartridgeId);
        delete result.cartridgeId;

        // ══════════════════════════════════════════════
        // IDEMPOTENCY CHECK - Detect duplicate upload
        // If cartridge already has results from THIS device, return cached status
        // ══════════════════════════════════════════════
        if ((cartridge.status === 'completed' || cartridge.status === 'cancelled') &&
            cartridge.rawData &&
            cartridge.device?.id === device.id) {

            console.log(`Idempotent retry detected for test upload: cartridge ${cartridge._id}, status: ${cartridge.status}`);

            // Return the same response type the original upload would have returned
            if (cartridge.validationErrors && cartridge.validationErrors.length > 0) {
                response = await send_response(device.id, 'upload-test', 'INVALID', { cartridgeId: cartridge._id });
            } else {
                response = await send_response(device.id, 'upload-test', 'SUCCESS', { cartridgeId: cartridge._id });
            }
            return response;
        }

        // ══════════════════════════════════════════════
        // NORMAL UPLOAD (first-time request)
        // ══════════════════════════════════════════════
        const when = new Date().toISOString();
        const who = 'brevitest-cloud';
        const where = cartridge.checkpoints.underway && cartridge.checkpoints.underway.where;
        cartridge.statusUpdatedOn = when;
        cartridge.status = result.numberOfReadings === 0 ? 'cancelled' : 'completed';
        cartridge.rawData = result;
        cartridge.day = Math.round(cartridge.hour / 24);
        cartridge.checkpoints.completed = { when, who, where };
        cartridge.validationErrors = [];
        if (cartridge.siteId !== 'research') {
            cartridge.hour = util.calculateCartridgeHours(cartridge);
            cartridge.checkpoints.completed = { when, who, where };
            cartridge.validationErrors = [];
            console.log('before recalc', cartridge);
            const recalc = evaluate(cartridge);
            console.log('after recalc', recalc);
            if (recalc) {
                const mutatedAttrs = Object.keys(recalc).filter((attr) => mutableAttrs.includes(attr));
                mutatedAttrs.forEach((attr) => (cartridge[attr] = recalc[attr]));
            }
        }
        const updatedCartridge = await saveDocument(cartridge, cartridge.siteId || cartridge.department);
        console.log('updatedCartridge', updatedCartridge);
        if (updatedCartridge.validationErrors && updatedCartridge.validationErrors.length > 0) {
            response = await send_response(device.id, 'upload-test', 'INVALID', { cartridgeId: cartridge._id });
        } else {
            response = await send_response(device.id, 'upload-test', 'SUCCESS', { cartridgeId: cartridge._id });
        }
    } catch (error) {
        if (error.message) {
            response = await send_response(device.id, 'upload-test', 'FAILURE', { errorMessage: error.message });
        } else {
            response = await send_response(device.id, 'upload-test', 'ERROR', { errorMessage: error });
        }
    }
    return response;
};

const within_bounds = (readings, max, min) => {
    return readings.reduce((ok, reading) => {
        return ok && (reading.L <= max && reading.L >= min);
    }, true);
};

const validate_magnetometer = (data) => {
    if (data && data.length) {
        return data.reduce((ok, well) => {
            return ok && (Math.abs(well.gauss_z) > process.env.MAGNET_MINIMUM_Z_GAUSS) && (Math.abs(well.temperature) > process.env.TEMPERATURE_MIN);
        }, true);
    } else {
        return false;
    }
};

const update_validation = async (eventName, deviceId, magnetometer) => {
    let response;
    try {
        let msg = '';
        let validated = false;
        const validationDate = new Date();
        response = await getDevice(deviceId);
        const validation = response.data.validation || {
            magnetometer: {}
        };
        if (magnetometer) {
            validation.magnetometer = { ...magnetometer, validationDate, valid: validate_magnetometer(magnetometer.data) };
            msg = validation.magnetometer.valid ? 'magnetometer valid' : 'magnetometer invalid';
        }
        validated = validation.magnetometer.valid;
        const device = {
            ...response.data,
            validated,
            validation
        };
        if (validated) {
            device.lastValidatedOn = validationDate;
        }
        await saveDocument(device, 'admin');
        response = await send_response(deviceId, eventName, 'SUCCESS', { message: msg });
    } catch (error) {
        response = await send_response(deviceId, eventName, 'ERROR', { errorMessage: error });
    }
    return response;
};

const validate_magnets = async (device, payload) => {
    const rows = payload.split('\n').slice(0, -1);
    const data = [];
    rows.slice(1).forEach((row) => {
        const well = row.split('\t');
        data.push({
            well: well[0],
            channel: "sample",
            temperature: parseFloat(well[1]),
            gauss_x: parseFloat(well[2]),
            gauss_y: parseFloat(well[3]),
            gauss_z: parseFloat(well[4])
        });
        data.push({
            well: well[0],
            channel: "control_low",
            temperature: parseFloat(well[5]),
            gauss_x: parseFloat(well[6]),
            gauss_y: parseFloat(well[7]),
            gauss_z: parseFloat(well[8])
        });
        data.push({
            well: well[0],
            channel: "control_high",
            temperature: parseFloat(well[9]),
            gauss_x: parseFloat(well[10]),
            gauss_y: parseFloat(well[11]),
            gauss_z: parseFloat(well[12])
        });
    });

    const magnetometer = {
        instrument: rows[0],
        data
    };

    const response = await update_validation('validate-magnets', device.id, magnetometer, null);
    return response;
};

const write_log = async (deviceId, event_type, status, data) => {
    const loggedOn = new Date();
    const _id = 'log_' + loggedOn.toISOString();
    const log_entry = {
        _id,
        schema: 'log',
        department: 'log',
        loggedOn,
        deviceId,
        type: event_type,
        status,
        data
    };

    await saveDocument(log_entry, 'log');
};

const send_response = async (deviceId, event_type, status, data = {}) => {
    const response = {
        statusCode: 200,
        "isBase64Encoded": false
    };

    await write_log(deviceId, event_type, status, data);
    response.body = JSON.stringify({
        status,
        ...data
    });
    if (response.body.length % 512 === 0) {
        response.body += ' ';
    }

    return response;
};

export const handler = async (event, context) => {
    let response;
    // console.log('event', event);
    if (event && event.body) {
        // console.log('typeof event.body', typeof event.body);
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        console.log('body',body.data?.length ?? null, typeof body?.data, body?.data ?? '');
        const device = await getDevice(body.device_id);
        // console.log('device', device);
        if (!device || !device.id) {
            response = await send_response(body.coreid, body.event, 'ERROR', { errorMessage: 'Missing device' });
        } else {
            switch (body.event) {
                case 'load-assay':
                    response = await load_assay(device, body);
                    break;
                case 'validate-cartridge':
                    response = await validate_cartridge(device, body);
                    break;
                case 'reset-cartridge':
                    response = await reset_cartridge(device, body);
                    break;
                case 'upload-test':
                    response = await test_upload(device, body);
                    break;
                case 'validate-magnets':
                    response = await validate_magnets(device, body.data);
                    break;
                case 'test-event':
                    response = await send_response(body.deviceId, body.event_type, 'SUCCESS', { message: 'Test event received' });
                    break;
                default:
                    response = await send_response(body.deviceId, body.event_type, 'FAILURE', { errorMessage: `Event type ${body.event_type} not found` });
                    break;
            }
        }
    } else {
        response = await send_response('unknown', 'unknown', 'ERROR', { errorMessage: 'Brevitest request malformed' });
    }
    console.log('response', response);
    return response;
};
