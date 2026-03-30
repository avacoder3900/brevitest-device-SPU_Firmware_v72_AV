/**
 * Lambda handler — unified version with logging pipeline.
 *
 * Changes from parallel middleware:
 *   1. Enhanced write_log() — captures full request context, processing time, firmware version
 *   2. New handle_device_log() — receives firmware session logs, parses checkpoint crash data
 *   3. Catch-all event archiving — every Particle event is archived to device_events
 *   4. Enhanced webhook logging — full request/response to webhook_logs collection
 *
 * All BCODE compilation, binary parsing, evaluation, and Particle Cloud logic is UNCHANGED.
 * CouchDB flow is fully preserved — if MONGODB_URI is not set, everything falls back to CouchDB.
 */

import util from './utilities.mjs';
import evaluate from './evaluate.mjs';
import db from './db-adapter.mjs';

const ARG_DELIM = ',';
const ATTR_DELIM = ':';
const ITEM_DELIM = '|';
const END_DELIM = "#";

// ---------------------------------------------------------------------------
// Checkpoint code names — mirrors firmware brevitest-firmware.h definitions.
// Used for human-readable crash reports.
// ---------------------------------------------------------------------------

const CHECKPOINT_NAMES = {
    10: 'CP_CLOUD_DISCONNECT',
    11: 'CP_CLOUD_DISCONNECT_OK',
    12: 'CP_CLOUD_CONNECT',
    13: 'CP_CLOUD_CONNECT_OK',
    14: 'CP_CLOUD_PUBLISH_VALIDATE',
    15: 'CP_CLOUD_PUBLISH_VALIDATE_OK',
    16: 'CP_CLOUD_PUBLISH_LOAD_ASSAY',
    17: 'CP_CLOUD_PUBLISH_LOAD_ASSAY_OK',
    18: 'CP_CLOUD_PUBLISH_UPLOAD',
    19: 'CP_CLOUD_PUBLISH_UPLOAD_OK',
    20: 'CP_CLOUD_PUBLISH_RESET',
    21: 'CP_CLOUD_PUBLISH_RESET_OK',
    22: 'CP_WEBHOOK_RESPONSE_RECEIVED',
    23: 'CP_WEBHOOK_TIMEOUT',
    30: 'CP_BCODE_START',
    31: 'CP_BCODE_COMPLETE',
    40: 'CP_SPECTRO_READING_START',
    41: 'CP_SPECTRO_READING_COMPLETE',
    50: 'CP_FILE_WRITE_TEST',
    51: 'CP_FILE_WRITE_TEST_OK',
    52: 'CP_FILE_READ_ASSAY',
    53: 'CP_FILE_READ_ASSAY_OK',
    54: 'CP_FILE_WRITE_ASSAY',
    55: 'CP_FILE_WRITE_ASSAY_OK',
    60: 'CP_STAGE_RESET',
    61: 'CP_STAGE_RESET_OK',
    62: 'CP_BARCODE_SCAN',
    63: 'CP_BARCODE_SCAN_OK',
    64: 'CP_I2C_BUS_INIT',
    65: 'CP_I2C_BUS_INIT_OK',
    70: 'CP_TEST_START',
    71: 'CP_TEST_HARDWARE_SETUP',
    80: 'CP_HEATER_OVERHEAT'
};

/**
 * Derive a crash category from the checkpoint code.
 * Matches the ranges defined in the firmware header.
 */
const crashCategoryForCheckpoint = (code) => {
    if (code >= 10 && code <= 23) return 'CLOUD';
    if (code >= 30 && code <= 31) return 'BCODE';
    if (code >= 40 && code <= 41) return 'I2C';
    if (code >= 50 && code <= 57) return 'FILE_IO';
    if (code >= 60 && code <= 67) return 'HARDWARE';
    if (code >= 70 && code <= 73) return 'TEST_LIFECYCLE';
    if (code >= 80) return 'HEATER';
    return 'UNKNOWN';
};

// ---------------------------------------------------------------------------
// Particle Cloud — UNCHANGED
// ---------------------------------------------------------------------------

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
            throw new Error(`Device ${deviceId} not found!`);
        } else {
            return null;
        }
    } catch (error) {
        throw new Error(error);
    }
};

// ---------------------------------------------------------------------------
// BCODE — UNCHANGED
// ---------------------------------------------------------------------------

const bcodeCommands = [{
    num: '0', name: 'START TEST', params: [],
    description: 'Starts the test. Required to be the first command.'
}, {
    num: '1', name: 'DELAY', params: ['delay_ms'],
    description: 'Waits for specified number of milliseconds.'
}, {
    num: '2', name: 'MOVE MICRONS', params: ['microns', 'step_delay_us'],
    description: 'Moves the stage a specified number of microns.'
}, {
    num: '3', name: 'OSCILLATE STAGE', params: ['microns', 'step_delay_us', 'cycles'],
    description: 'Oscillates back and forth a given distance.'
}, {
    num: '4', name: 'SINUSOIDAL OSCILLATE', params: ['microns', 'peak_delay_us', 'shape_pct', 'cycles'],
    description: 'Oscillates with sinusoidal velocity profile.'
}, {
    num: '5', name: 'SINUSOIDAL MOVE', params: ['microns', 'peak_delay_us', 'shape_pct'],
    description: 'One half-stroke with sinusoidal velocity profile.'
}, {
    num: '10', name: 'SET SENSOR PARAMS', params: ['gain', 'step', 'time'],
    description: 'Set sensor parameters.'
}, {
    num: '11', name: 'READ BASELINE', params: ['scans'],
    description: 'Read sensors with number of samples.'
}, {
    num: '14', name: 'READ TEST', params: ['scans'],
    description: 'Read sensors with number of samples.'
}, {
    num: '15', name: 'READ SENSOR', params: ['channel', 'gain', 'step', 'time'],
    description: 'Raw sensor read.'
}, {
    num: '16', name: 'SCAN SENSOR', params: ['baseline', 'starting_position', 'distance_to_scan', 'step_delay'],
    description: 'Continuous sensor read.'
}, {
    num: '20', name: 'REPEAT', params: ['count'],
    description: 'Repeats the block of BCODE.'
}, {
    num: '98', name: 'COMMENT', params: ['text'],
    description: 'Comment - ignored by system.'
}, {
    num: '99', name: 'FINISH TEST', params: [],
    description: 'Finishes the test. Required to be the final command.'
}];

const getBcodeCommand = (command) => {
    return bcodeCommands.find(e => e.name === command);
};

const instructionTime = (command, params) => {
    switch (command) {
        case 'DELAY':
            return parseInt(params.delay_ms, 10);
        case 'MOVE MICRONS':
            return Math.floor(2 * Math.abs(parseInt(params.microns, 10)) * parseInt(params.step_delay_us, 10) / 25000);
        case 'OSCILLATE STAGE':
            return Math.floor(4 * parseInt(params.cycles, 10) * Math.abs(parseInt(params.microns, 10)) * parseInt(params.step_delay_us, 10) / 25000);
        case 'SINUSOIDAL OSCILLATE': {
            const microns = Math.abs(parseInt(params.microns, 10));
            const peakDelay = parseInt(params.peak_delay_us, 10);
            const shape = parseInt(params.shape_pct, 10) / 100.0;
            const cycles = parseInt(params.cycles, 10);
            const N = Math.floor(microns / 25);
            let sumInv = 0;
            for (let i = 0; i < N; i++) {
                sumInv += 1.0 / Math.pow(Math.sin(Math.PI * (i + 0.5) / N), shape);
            }
            return Math.floor(peakDelay * sumInv * 2 * cycles / 1000);
        }
        case 'SINUSOIDAL MOVE': {
            const microns = Math.abs(parseInt(params.microns, 10));
            const peakDelay = parseInt(params.peak_delay_us, 10);
            const shape = parseInt(params.shape_pct, 10) / 100.0;
            const N = Math.floor(microns / 25);
            let sumInv = 0;
            for (let i = 0; i < N; i++) {
                sumInv += 1.0 / Math.pow(Math.sin(Math.PI * (i + 0.5) / N), shape);
            }
            return Math.floor(peakDelay * sumInv / 1000);
        }
        case 'READ BASELINE':
        case 'READ TEST':
        case 'READ SENSOR':
        case 'SCAN SENSOR':
            return 5000;
        case 'START TEST':
            return 9000;
        case 'FINISH TEST':
            return 8000;
    }
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
    const argKeys = keys.length ? keys.filter(k => k.toLowerCase() !== 'comment') : [];
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

// ---------------------------------------------------------------------------
// Binary parsing — UNCHANGED
// ---------------------------------------------------------------------------

const mutableAttrs = ['name', 'readouts', 'validationErrors', 'result', 'reading', 'referenceRange', 'day', 'hour'];

const frequencies = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir'];
const parseReading = (byteArray, offset) => {
    const result = {
        number: byteArray.readUint8(offset),
        channel: byteArray.slice(offset + 1, offset + 2).toString(),
        position: byteArray.readUint16LE(offset + 2),
        temperature: byteArray.readUint16LE(offset + 4),
        laser_output: byteArray.readUint16LE(offset + 6),
        msec: byteArray.readUint32LE(offset + 8)
    };
    frequencies.forEach((f, ii) => {
        result[f] = byteArray.readUint16LE(offset + 12 + (2 * ii));
    });
    return result;
};

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
};

const parsePayload = (body) => {
    const headerLength = 'data:application/octet-stream;base64,'.length;
    const byteArray = Buffer.from(body.data.slice(headerLength), 'base64');
    return parseByteArray(byteArray);
};

// ---------------------------------------------------------------------------
// Magnetometer validation — UNCHANGED
// ---------------------------------------------------------------------------

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
        // Device validation saves to CouchDB admin (unchanged — devices aren't in MongoDB yet)
        const couchHeaders = new Headers();
        couchHeaders.append('Authorization', `Basic ${process.env.COUCHDB_BASE64_CREDENTIAL}`);
        const options = { method: 'PUT', headers: couchHeaders, body: JSON.stringify(device) };
        await fetch(`${process.env.COUCHDB_BASEURL}/admin/${device._id}`, options);
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
        data.push({ well: well[0], channel: "sample", temperature: parseFloat(well[1]), gauss_x: parseFloat(well[2]), gauss_y: parseFloat(well[3]), gauss_z: parseFloat(well[4]) });
        data.push({ well: well[0], channel: "control_low", temperature: parseFloat(well[5]), gauss_x: parseFloat(well[6]), gauss_y: parseFloat(well[7]), gauss_z: parseFloat(well[8]) });
        data.push({ well: well[0], channel: "control_high", temperature: parseFloat(well[9]), gauss_x: parseFloat(well[10]), gauss_y: parseFloat(well[11]), gauss_z: parseFloat(well[12]) });
    });
    const magnetometer = { instrument: rows[0], data };
    const response = await update_validation('validate-magnets', device.id, magnetometer);
    return response;
};

// ---------------------------------------------------------------------------
// Logging & response — ENHANCED with full request context + webhook_logs
// ---------------------------------------------------------------------------

/**
 * Legacy write_log — still writes to CouchDB 'log' database for backward compat.
 * This is called by send_response for every webhook round-trip.
 */
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
    // Write to CouchDB log database (and MongoDB logs collection if available)
    await db.saveDocument(log_entry, 'log');
};

/**
 * Enhanced webhook logging — captures full request + response + timing.
 * Written to the webhook_logs MongoDB collection (separate from legacy CouchDB logs).
 */
const write_webhook_log = async (deviceId, eventName, requestContext, responseStatus, responseData, startTime) => {
    const webhookLog = {
        deviceId,
        eventName,
        timestamp: new Date(),
        processingTimeMs: Date.now() - startTime,
        request: {
            raw: requestContext.rawBody,
            parsed: requestContext.parsedData,
            particlePublishedAt: requestContext.publishedAt || null
        },
        response: {
            status: responseStatus,
            data: responseData,
            errorMessage: responseData?.errorMessage || null
        },
        cartridgeId: requestContext.cartridgeId || null,
        assayId: requestContext.assayId || null,
        firmwareVersion: requestContext.firmwareVersion || null
    };
    // Best-effort — don't let logging failure break the webhook response
    try {
        await db.saveWebhookLog(webhookLog);
    } catch (err) {
        console.error('write_webhook_log failed:', err.message);
    }
};

const send_response = async (deviceId, event_type, status, data = {}) => {
    const response = {
        statusCode: 200,
        "isBase64Encoded": false
    };

    await write_log(deviceId, event_type, status, data);
    response.body = JSON.stringify({ status, ...data });
    if (response.body.length % 512 === 0) {
        response.body += ' ';
    }
    return response;
};

// ---------------------------------------------------------------------------
// NEW HANDLER: device-log — receives firmware session logs
// ---------------------------------------------------------------------------

/**
 * Parse raw session log text into structured log lines.
 *
 * Firmware log format: "millis|message\n"
 * Example: "142000|HEAT: T=45.0 target=45.0 pwr=12 err=0 int=200"
 *
 * Also handles session header blocks and checkpoint dump blocks.
 */
const parseLogLines = (rawText) => {
    const lines = rawText.split('\n').filter(l => l.trim().length > 0);
    return lines.map(line => {
        const pipeIndex = line.indexOf('|');
        if (pipeIndex > 0) {
            const ms = parseInt(line.substring(0, pipeIndex), 10);
            const message = line.substring(pipeIndex + 1);
            return { ms: isNaN(ms) ? 0 : ms, message };
        }
        // Lines without pipe separator (e.g., session headers)
        return { ms: 0, message: line };
    });
};

/**
 * Parse the checkpoint block from the top of a session log.
 * Looks for the PREV SESSION CHECKPOINTS block that dump_checkpoint_trail() writes.
 *
 * Returns { wasInterrupted, lastCheckpoint, bootCount, checkpointSequence } or null if not found.
 */
const parseCheckpointBlock = (logLines) => {
    let inBlock = false;
    let wasInterrupted = false;
    let lastCheckpoint = null;
    let bootCount = null;
    const checkpointSequence = [];

    for (const line of logLines) {
        const msg = line.message;

        // Start of checkpoint block
        if (msg.includes('PREV SESSION CHECKPOINTS')) {
            inBlock = true;
            const bootMatch = msg.match(/boot #(\d+)/);
            if (bootMatch) {
                bootCount = parseInt(bootMatch[1], 10);
            }
            continue;
        }

        // End of checkpoint block
        if (msg.includes('END CHECKPOINTS')) {
            break;
        }

        if (inBlock) {
            // Check for interruption marker
            if (msg.includes('INTERRUPTED at checkpoint')) {
                wasInterrupted = true;
                const cpMatch = msg.match(/checkpoint (\d+)/);
                if (cpMatch) {
                    lastCheckpoint = parseInt(cpMatch[1], 10);
                }
            }

            // Parse checkpoint entries: "  CP[0] = 70" or "  CP[0]  = 70"
            const entryMatch = msg.match(/CP\[\d+\]\s*=\s*(\d+)/);
            if (entryMatch) {
                checkpointSequence.push(parseInt(entryMatch[1], 10));
            }
        }
    }

    if (checkpointSequence.length === 0) return null;

    // If not explicitly interrupted, the last checkpoint is the final entry
    if (lastCheckpoint === null && checkpointSequence.length > 0) {
        lastCheckpoint = checkpointSequence[checkpointSequence.length - 1];
    }

    return { wasInterrupted, lastCheckpoint, bootCount, checkpointSequence };
};

/**
 * Extract metadata from the session header block.
 * Looks for lines like:
 *   "Boot #47 | Device: e00fce68..."
 *   "Firmware: v71 | Format: v40"
 *   "Time: 2026-03-11T15:30:00Z"
 */
const parseSessionHeader = (logLines) => {
    const header = {
        bootCount: null,
        deviceId: null,
        firmwareVersion: null,
        dataFormatVersion: null,
        bootTime: null
    };

    for (const line of logLines) {
        const msg = line.message;

        const bootMatch = msg.match(/Boot #(\d+)\s*\|\s*Device:\s*(\S+)/);
        if (bootMatch) {
            header.bootCount = parseInt(bootMatch[1], 10);
            header.deviceId = bootMatch[2];
        }

        const fwMatch = msg.match(/Firmware:\s*v(\d+)\s*\|\s*Format:\s*v(\d+)/);
        if (fwMatch) {
            header.firmwareVersion = parseInt(fwMatch[1], 10);
            header.dataFormatVersion = parseInt(fwMatch[2], 10);
        }

        const timeMatch = msg.match(/Time:\s*(.+)/);
        if (timeMatch) {
            header.bootTime = new Date(timeMatch[1].trim());
        }

        // Stop searching after we've passed the header area (first ~20 lines)
        if (line.ms > 0 && !msg.includes('SESSION') && !msg.includes('Boot') && !msg.includes('Firmware') && !msg.includes('CP[')) {
            break;
        }
    }

    return header;
};

/**
 * Handle a device-log event from firmware.
 *
 * The firmware uploads its session log file when idle + cloud connected.
 * This handler:
 *   1. Parses the raw log text into structured lines
 *   2. Extracts session metadata (firmware version, boot count, device ID)
 *   3. Parses the checkpoint block for crash detection
 *   4. Saves the full session log to device_logs collection
 *   5. If a crash was detected, saves a crash report to device_crashes collection
 *   6. Returns SUCCESS so the device knows to delete the file from flash
 */
const handle_device_log = async (device, body) => {
    const startTime = Date.now();
    let response;
    try {
        // The firmware sends log data — could be raw text or base64-encoded binary
        let rawText;
        if (body.data && body.data.startsWith('data:application/octet-stream;base64,')) {
            // Binary upload via loadData() — same pattern as upload-test
            const headerLength = 'data:application/octet-stream;base64,'.length;
            const buffer = Buffer.from(body.data.slice(headerLength), 'base64');
            rawText = buffer.toString('utf-8');
        } else {
            // Plain text (e.g., if sent via Particle.publish() directly)
            rawText = typeof body.data === 'string' ? body.data : JSON.stringify(body.data);
        }

        console.log('handle_device_log: received', rawText.length, 'bytes from device', device.id);

        // Parse the log
        const logLines = parseLogLines(rawText);
        const sessionHeader = parseSessionHeader(logLines);
        const checkpointData = parseCheckpointBlock(logLines);

        // Count errors/warnings in log
        const errorCount = logLines.filter(l =>
            l.message.includes('ERROR') ||
            l.message.includes('WARN') ||
            l.message.includes('OVERHEAT') ||
            l.message.includes('THERMISTOR DISCONNECT') ||
            l.message.includes('INTERRUPTED')
        ).length;

        // Build the device_logs document
        const deviceLogDoc = {
            deviceId: device.id,
            deviceName: device.name || null,
            sessionId: `${device.id}_boot${sessionHeader.bootCount || 'unknown'}_${new Date().toISOString()}`,
            firmwareVersion: sessionHeader.firmwareVersion,
            dataFormatVersion: sessionHeader.dataFormatVersion,
            bootCount: sessionHeader.bootCount,
            bootTime: sessionHeader.bootTime || new Date(),
            uploadedAt: new Date(),
            logLines,
            lineCount: logLines.length,
            errorCount,
            hasCrash: checkpointData?.wasInterrupted || false,
            firstLine: logLines.length > 0 ? logLines[0].message : '',
            lastLine: logLines.length > 0 ? logLines[logLines.length - 1].message : ''
        };

        // Save the session log
        const savedLog = await db.saveDeviceLog(deviceLogDoc);

        // If crash detected, create a crash report
        if (checkpointData && checkpointData.wasInterrupted) {
            const crashDoc = {
                deviceId: device.id,
                deviceName: device.name || null,
                firmwareVersion: sessionHeader.firmwareVersion,
                bootCount: checkpointData.bootCount,
                detectedAt: new Date(),
                lastCheckpoint: checkpointData.lastCheckpoint,
                lastCheckpointName: CHECKPOINT_NAMES[checkpointData.lastCheckpoint] || `UNKNOWN_${checkpointData.lastCheckpoint}`,
                checkpointSequence: checkpointData.checkpointSequence,
                crashCategory: crashCategoryForCheckpoint(checkpointData.lastCheckpoint),
                sessionLogId: savedLog?._id || null
            };
            await db.saveDeviceCrash(crashDoc);
            console.log('handle_device_log: CRASH DETECTED at checkpoint', crashDoc.lastCheckpoint, crashDoc.lastCheckpointName);
        }

        // Enhanced webhook log for this device-log upload
        await write_webhook_log(device.id, 'device-log', {
            rawBody: `[${rawText.length} bytes]`,
            parsedData: {
                lineCount: logLines.length,
                errorCount,
                hasCrash: checkpointData?.wasInterrupted || false,
                firmwareVersion: sessionHeader.firmwareVersion,
                bootCount: sessionHeader.bootCount
            },
            firmwareVersion: sessionHeader.firmwareVersion
        }, 'SUCCESS', { lineCount: logLines.length }, startTime);

        response = await send_response(device.id, 'device-log', 'SUCCESS', {
            lineCount: logLines.length,
            crashDetected: checkpointData?.wasInterrupted || false
        });
    } catch (error) {
        console.error('handle_device_log error:', error);
        response = await send_response(device.id, 'device-log', 'FAILURE', {
            errorMessage: error.message || 'Unknown error processing device log'
        });
    }
    return response;
};

// ---------------------------------------------------------------------------
// HANDLER: load_assay — CHANGED to use adapter
// ---------------------------------------------------------------------------

const load_assay = async (device, body) => {
    let response;
    const data = {};
    try {
        console.log('body', body);
        const parsed = JSON.parse(body.data);
        const assayId = parsed?.assay_id ?? '';
        console.log('load_assay', assayId);
        if (!assayId) {
            response = await send_response(assayId, 'load-assay', 'FAILURE', { errorMessage: `Assay ID missing` });
        } else {
            // CHANGED: Use adapter — searches MongoDB assay_definitions first, then CouchDB
            const assay = await db.loadAssayById(assayId, 'research');
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

// ---------------------------------------------------------------------------
// HANDLER: validate_cartridge — CHANGED to use adapter
// ---------------------------------------------------------------------------

const validate_cartridge = async (device, body) => {
    let response;
    try {
        const data = JSON.parse(body.data);
        console.log('validate_cartridge', data);
        const cartridgeId = data?.uuid ?? '';
        if (!cartridgeId) {
            throw new Error(`FAILURE: Cartridge ID is missing.`);
        }

        const today = new Date();
        // CHANGED: Use adapter — searches MongoDB cartridge_records first, then CouchDB
        const cartridge = await db.loadCartridgeById(cartridgeId);
        console.log('today', today, cartridge && cartridge.expirationDate);
        if (!cartridge) {
            throw new Error(`Cartridge ${cartridgeId} missing, may be deleted`);
        } else if (cartridge.used) {
            throw new Error(`Cartridge ${cartridgeId} already used`);
        } else if (cartridge.expirationDate && new Date(cartridge.expirationDate) < today) {
            throw new Error(`Cartridge ${cartridgeId} is expired`);
        } else if (cartridge.status !== 'linked' && cartridge.status !== 'underway') {
            throw new Error(`Cartridge ${cartridgeId} is not linked or underway`);
        }

        const assayId = cartridge.assayId;
        if (cartridge.status !== 'underway') {
            // CHANGED: Use adapter for assay lookup
            const couchDb = cartridge.siteId === 'research' ? 'research' : 'admin';
            const assay = await db.loadAssayById(assayId, couchDb);
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
            if (!cartridge.checkpoints) cartridge.checkpoints = {};
            cartridge.checkpoints.underway = { when, who, where };
            cartridge.statusUpdatedOn = when;
            // CHANGED: Use adapter — writes to MongoDB and/or CouchDB based on source
            await db.saveDocument(cartridge, cartridge.siteId ?? 'research');
        }
        const checksum = util.checksum(bcodeCompile(cartridge.assay.BCODE.code));
        response = await send_response(device.id, 'validate-cartridge', 'SUCCESS', { cartridgeId, assayId, checksum });
    } catch (error) {
        if (error.message) {
            response = await send_response(device.id, 'validate-cartridge', 'FAILURE', { errorMessage: error.message });
        } else {
            response = await send_response(device.id, 'validate-cartridge', 'ERROR', { errorMessage: error });
        }
    }
    return response;
};

// ---------------------------------------------------------------------------
// HANDLER: reset_cartridge — CHANGED to use adapter
// ---------------------------------------------------------------------------

const reset_cartridge = async (device, body) => {
    let response;
    try {
        const data = JSON.parse(body.data);
        console.log('reset_cartridge', data);
        const cartridgeId = data?.uuid ?? '';
        if (!cartridgeId) {
            throw new Error(`FAILURE: Cartridge ID is missing.`);
        }

        // CHANGED: Use adapter
        const cartridge = await db.loadCartridgeById(cartridgeId);
        if (!(cartridge.status === 'underway' || cartridge.status === 'cancelled')) {
            throw new Error(`FAILURE: Cartridge status is not underway or cancelled.`);
        }
        cartridge.status = 'linked';
        cartridge.statusUpdatedOn = new Date().toISOString();
        delete cartridge.used;
        delete cartridge.device;
        delete cartridge.assay;
        delete cartridge.day;
        if (cartridge.checkpoints) {
            delete cartridge.checkpoints.cancelled;
            delete cartridge.checkpoints.underway;
        }
        delete cartridge.rawData;
        delete cartridge.validationErrors;
        delete cartridge.readouts;
        delete cartridge.reading;
        delete cartridge.result;
        delete cartridge.referenceRange;
        // CHANGED: Use adapter
        const updatedCartridge = await db.saveDocument(cartridge, cartridge.siteId ?? 'research');
        console.log('updatedCartridge', updatedCartridge);
        response = await send_response(device.id, 'reset-cartridge', 'SUCCESS', { cartridgeId });
    } catch (error) {
        if (error.message) {
            response = await send_response(device.id, 'reset-cartridge', 'FAILURE', { errorMessage: error.message });
        } else {
            response = await send_response(device.id, 'reset-cartridge', 'ERROR', { errorMessage: error });
        }
    }
    return response;
};

// ---------------------------------------------------------------------------
// HANDLER: test_upload — CHANGED to use adapter
// ---------------------------------------------------------------------------

const test_upload = async (device, body) => {
    let response;
    try {
        const result = parsePayload(body);
        if (!result.cartridgeId) {
            throw new Error(`FAILURE: Cartridge ID uploaded in device ${device.id} is missing.`);
        }
        // CHANGED: Use adapter
        const cartridge = await db.loadCartridgeById(result.cartridgeId);
        delete result.cartridgeId;
        let updatedCartridge;
        if (cartridge.status === 'completed' || cartridge.status === 'cancelled') {
            // Idempotency: already processed, return cached result
            updatedCartridge = cartridge;
        } else {
            const when = new Date().toISOString();
            const who = 'brevitest-cloud';
            const where = cartridge.checkpoints?.underway?.where;
            cartridge.statusUpdatedOn = when;
            cartridge.status = result.numberOfReadings === 0 ? 'cancelled' : 'completed';
            cartridge.rawData = result;
            if (!cartridge.checkpoints) cartridge.checkpoints = {};
            cartridge.checkpoints[cartridge.status] = { when, who, where };
            cartridge.validationErrors = [];
            // Evaluate only for non-research cartridges (unchanged logic)
            if (cartridge.siteId && cartridge.siteId !== 'research') {
                cartridge.day = Math.round(cartridge.hour / 24);
                cartridge.hour = util.calculateCartridgeHours(cartridge);
                cartridge.validationErrors = [];
                console.log('before recalc', cartridge);
                const recalc = evaluate(cartridge);
                console.log('after recalc', recalc);
                if (recalc) {
                    const mutatedAttrs = Object.keys(recalc).filter((attr) => mutableAttrs.includes(attr));
                    mutatedAttrs.forEach((attr) => (cartridge[attr] = recalc[attr]));
                }
            }
            // CHANGED: Use adapter
            updatedCartridge = await db.saveDocument(cartridge, cartridge.siteId || cartridge.department || 'research');
        }
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

// ---------------------------------------------------------------------------
// Main handler — ENHANCED with device-log + event archiving
// ---------------------------------------------------------------------------

export const handler = async (event, context) => {
    let response;
    const startTime = Date.now();

    if (event && event.body) {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        console.log('body', body.data?.length ?? null, typeof body?.data, body?.data ?? '');
        const device = await getDevice(body.device_id);

        // Archive every incoming Particle event (best-effort, non-blocking)
        try {
            await db.saveDeviceEvent({
                deviceId: body.device_id || body.coreid,
                eventName: body.event,
                data: body.data,
                publishedAt: body.published_at ? new Date(body.published_at) : new Date(),
                archivedAt: new Date()
            });
        } catch (err) {
            console.error('Event archiving failed (non-fatal):', err.message);
        }

        if (!device || !device.id) {
            response = await send_response(body.coreid, body.event, 'ERROR', { errorMessage: 'Missing device' });
        } else {
            // Build request context for enhanced webhook logging
            const requestContext = {
                rawBody: typeof body.data === 'string' ? body.data.substring(0, 500) : JSON.stringify(body.data).substring(0, 500),
                parsedData: null,
                publishedAt: body.published_at || null,
                firmwareVersion: device.firmware_version || null,
                cartridgeId: null,
                assayId: null
            };

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
                case 'device-log':
                    response = await handle_device_log(device, body);
                    break;
                case 'test-event':
                    response = await send_response(body.deviceId, body.event_type, 'SUCCESS', { message: 'Test event received' });
                    break;
                default:
                    response = await send_response(body.deviceId, body.event_type, 'FAILURE', { errorMessage: `Event type ${body.event_type} not found` });
                    break;
            }

            // Write enhanced webhook log for all events (device-log does its own)
            if (body.event !== 'device-log') {
                const responseBody = response?.body ? JSON.parse(response.body) : {};
                await write_webhook_log(
                    device.id,
                    body.event,
                    requestContext,
                    responseBody.status || 'UNKNOWN',
                    responseBody,
                    startTime
                );
            }
        }
    } else {
        response = await send_response('unknown', 'unknown', 'ERROR', { errorMessage: 'Brevitest request malformed' });
    }
    console.log('response', response);
    return response;
};
