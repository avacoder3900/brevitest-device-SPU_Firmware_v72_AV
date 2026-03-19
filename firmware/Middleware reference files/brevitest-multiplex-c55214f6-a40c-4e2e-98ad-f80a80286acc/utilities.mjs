import dayjs from 'dayjs'

const crc32tab = [
	0x00000000, 0x77073096, 0xee0e612c, 0x990951ba,
	0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
	0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988,
	0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
	0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de,
	0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
	0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec,
	0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
	0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172,
	0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
	0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940,
	0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
	0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116,
	0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
	0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924,
	0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
	0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a,
	0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
	0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818,
	0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
	0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e,
	0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
	0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c,
	0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
	0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2,
	0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
	0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0,
	0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
	0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086,
	0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
	0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4,
	0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
	0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a,
	0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
	0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8,
	0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
	0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe,
	0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
	0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc,
	0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
	0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252,
	0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
	0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60,
	0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
	0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236,
	0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
	0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04,
	0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
	0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a,
	0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
	0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38,
	0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
	0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e,
	0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
	0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c,
	0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
	0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2,
	0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
	0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0,
	0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
	0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6,
	0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
	0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94,
	0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d
];

const checksum = (str) => {
    let crc = ~0, i, l;
    for (i = 0, l = str.length; i < l; i++) {
        crc = (crc >>> 8) ^ crc32tab[(crc ^ str.charCodeAt(i)) & 0xff];
    }
    crc = Math.abs(crc ^ -1);
    return crc;
};

const sqrt3 = Math.sqrt(3);

const max = (a, b) => (a > b ? a : b);
const min = (a, b) => (a < b ? a : b);

const between = (v, l) => (v >= l.min && v <= l.max);

const arrayMax = (a) => a.reduce((r, i) => (r > i ? r : i), -1e10);
const arrayMin = (a) => a.reduce((r, i) => (r < i ? r : i), 1e10);

const dehydrate = (obj) => JSON.parse(JSON.stringify(obj));

const round = (a, digits) => {
    const type = typeof a;
    if (a === null || type === 'undefined') {
        return null;
    } else if (type === 'object') {
        if (Array.isArray(a)) {
            return a.map((e) => round(e, digits));
        } else {
            const keys = Object.keys(a);
            return keys.reduce((obj, key) => ({ ...obj, [key]: round(a[key], digits) }), {});
        }
    } else if (type === 'number') {
        if (typeof digits === 'undefined') {
            const d = 3 - Math.floor(Math.log10(Math.abs(a)));
            return Number.parseFloat(a.toFixed(!Number.isInteger(d) || d < 0 ? 0 : d));
        } else {
            return Number.parseFloat(a.toFixed(digits));
        }
    } else if (type === 'string') {
        if (typeof digits === 'undefined') {
            const v = Number.parseFloat(a);
            const d = 3 - Math.floor(Math.log10(Math.abs(v)));
            return Number.parseFloat(v.toFixed(!Number.isInteger(d) || d < 0 ? 0 : d));
        } else {
            return Number.parseFloat(Number.parseFloat(a).toFixed(digits));
        }
    } else {
        return a;
    }
};

const rangedRand = (low, high) => {
    return low + Math.random() * (high - low);
};

const datasetExtent = (dataset) => {
    return dataset.data.reduce(
        (e, pt) => {
            e.xMax = max(e.xMax, pt.x);
            e.xMin = min(e.xMin, pt.x);
            e.yMax = max(e.yMax, pt.y);
            e.yMin = min(e.yMin, pt.y);
            return e;
        },
        { xMax: -1e10, xMin: 1e10, yMax: -1e10, yMin: 1e10 }
    );
};

const chartExtent = (datasets) => {
    return datasets.reduce(
        (result, ds) => {
            return ds.data.reduce((e, pt) => {
                e.xMax = max(e.xMax, pt.x);
                e.xMin = min(e.xMin, pt.x);
                e.yMax = max(e.yMax, pt.y);
                e.yMin = min(e.yMin, pt.y);
                return e;
            }, result);
        },
        { xMax: -1e10, xMin: 1e10, yMax: -1e10, yMin: 1e10 }
    );
};

const combineAndSortNumberArrays = (a1, a2) => {
    const baseArray = a1.length > a2.length ? a1 : a2;
    const arrayToAdd = a1.length > a2.length ? a2 : a1;
    const a = arrayToAdd.filter((item) => !baseArray.includes(item));
    return [...baseArray, ...a].sort((a, b) => a - b);
};

const linearPredict = (x, x0, y0, x1, y1) => {
    if (x0 === x1) {
        return (y0 + y1) / 2;
    } else {
        const t = x / (x1 - x0);
        return (1 - t) * y0 + t * y1;
    }
};

const derivative = (a, b, x, y) => {
    return (a[y || 'L'] - b[y || 'L']) / (b[x || 'time'] - a[x || 'time']);
};

const vectorMagnitude = (v) => {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
};

const vectorScale = (a, scale) => {
    return { x: scale * a.x, y: scale * a.y, z: scale * a.z };
};

const vectorAdd = (a, b) => {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
};

const vectorSubtract = (a, b) => {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
};

const vectorVariance = (a, b) => {
    return { x: (a.x - b.x) * (a.x - b.x), y: (a.y - b.y) * (a.y - b.y), z: (a.z - b.z) * (a.z - b.z) };
};

const vectorDot = (a, b) => {
    return a.x * b.x + a.y * b.y + a.z * b.z;
};

const vectorSum = (points) => {
    return points.reduce((total, point) => vectorAdd(total, point), { x: 0, y: 0, z: 0 });
};

const vectorMean = (points) => {
    const count = points.length;
    const sum = vectorSum(points);
    return { x: sum.x / count, y: sum.y / count, z: sum.z / count };
};

const vectorMeanIndexed = (points, indexes) => {
    const count = indexes.length;
    const sum = indexes.reduce((total, index) => vectorAdd(total, points[index]), { x: 0, y: 0, z: 0 });
    return { x: sum.x / count, y: sum.y / count, z: sum.z / count };
};

const vectorDistance = (a, b) => {
    return vectorMagnitude(vectorSubtract(a, b));
};

const vectorAbsorption = (baseline, reading, scale) => {
    const mag = vectorMagnitude({
        x: reading.x ? baseline.x / reading.x : 0,
        y: reading.y ? baseline.y / reading.y : 0,
        z: reading.z ? baseline.z / reading.z : 0
    });
    return Math.round((mag / sqrt3) * (scale || 1000));
};

const vectorPredict = (a, b, t) => {
    return vectorAdd(a, vectorScale(vectorSubtract(b, a), t));
};

const calcLinear = ([m, b]) => {
    return (x) => m * x + b;
};

const invLinear = ([m, b]) => {
    return (y) => (y - b) / m;
};

const calc3PLC = ([b, c, d]) => {
    return (x) => d - d / (1 + Math.pow(x / c, b));
};

const inv3PLC = ([a, b, c]) => {
    return (y) => c * Math.pow(a / y - 1, 1 / -b);
};

const calc4PLCv1 = ([a, b, c, d]) => {
    return (x) => a + (d - a) / (1 + Math.pow(x / c, b));
};

const inv4PLCv1 = ([a, b, c, d]) => {
    return (y) => c * Math.pow((d - a) / (d - y) - 1, 1 / b);
};

const calc4PLC = ([a, b, c, d]) => {
    return (x) => d + (a - d) / (1 + Math.pow(x / c, b));
};

const inv4PLC = ([a, b, c, d]) => {
    return (y) => c * Math.pow((a - d) / (y - d) - 1, 1 / b);
};

const calcQuadratic = ([a, b, c]) => {
    return (x) => a * x * x + b * x + c;
};

const invQuadratic = ([a, b, c]) => {
    return (y) => {
        const n = Math.sqrt(b * b - 4 * c);
        const d = 2 * a;
        return max((-b + n) / d, (-b - n) / d);
    };
};

const channelAPoints = (cartridge) => {
    return cartridge.rawData.points.filter((_, i) => (i % 3) === 0);
};

const channelBPoints = (cartridge) => {
    return cartridge.rawData.points.filter((_, i) => (i % 3) === 1);
};

const channelCPoints = (cartridge) => {
    return cartridge.rawData.points.filter((_, i) => (i % 3) === 2);
};

const channelPoints = (cartridge, channel) => {
    return channel === 'A' ? channelAPoints(cartridge) : channel === '1' || channel === 'B' ? channelBPoints(cartridge) : channelCPoints(cartridge);
};

const baselines = (cartridge, points) => {
    const num = numberOfBaselines(cartridge);
    if (points) {
        return points.slice(0, num);
    } else {
        return cartridge.rawData.points.slice(0, 3 * num);
    }
};

const readings = (cartridge, points) => {
    const num = numberOfBaselines(cartridge);
    if (points) {
        return points.slice(num);
    } else {
        return cartridge.rawData.points.slice(3 * num);
    }
};

const numberOfBaselines = (cartridge) => {
    const bcode = cartridge.assay.BCODE.code;
    const baselineCmd = bcode.find((code) => code.command.toUpperCase() === 'SET BASELINE AND READ SENSORS');
    return baselineCmd ? baselineCmd.params.number_of_readings : 2;
};

const baselineTime = (cartridge) => {
    const bcode = cartridge.assay.BCODE.code;
    const baselineTimeCmd = bcode.find((code) => code.command.toUpperCase() === 'SET BASELINE TIME');
    if (baselineTimeCmd) {
        return cartridge.rawData.points[0].time;
    } else {
        return null;
    }
};

const channelDistanceChange = (cartridge, channel) => {
    const vector = channelPoints(cartridge, channel);
    return vectorDistance(vectorMean(baselines(cartridge, vector)), vectorMean(readings(cartridge, vector)));
};

const channelAbsorptionChange = (cartridge, channel, scale) => {
    const vector = channelPoints(cartridge, channel);
    return vectorAbsorption(vectorMean(baselines(cartridge, vector)), vectorMean(readings(cartridge, vector)), scale);
};

const processChannels = (cartridge) => {
    const channelA = channelDistanceChange(cartridge, 'A');
    const channelB = channelDistanceChange(cartridge, 'B');
    const channelC = channelDistanceChange(cartridge, 'C');
    const channelAC = 0.5 * (channelA + channelC);
    const range = Math.abs(channelA - channelC) / channelB;
    return [channelA, channelB, channelC, channelAC, range];
};

const inverse = (type, params, readout) => {
    if (type === 'linear least squares') {
        return invLinear(params)(readout);
    } else if (type === 'three parameter logistic') {
        return inv3PLC(params)(readout);
    } else if (type === 'four parameter logistic') {
        if (readout >= params[0]) {
            return 1e6;
        }
        return inv4PLCv1(params)(readout);
    } else if (type === '4PLC') {
        if (readout >= params.d) {
            return 2000;
        }
        if (readout <= params.a) {
            return 0;
        }
        return bounded(inv4PLC([params.a, params.b, params.c, params.d])(readout), { max: 2000, min: 0 });
    } else {
        return null;
    }
};

const calc = (type, params, readout) => {
    if (type === 'linear least squares') {
        return calcLinear(params)(readout);
    } else if (type === 'polynomial') {
        return params.reduce((a, b, n) => a + b * readout ** n);
    } else if (type === 'three parameter logistic') {
        return calc3PLC(params)(readout);
    } else if (type === 'four parameter logistic') {
        if (readout >= params[0]) {
            return 1e6;
        }
        return calc4PLCv1(params)(readout);
    } else if (type === '4PLC') {
        return calc4PLC([params.a, params.b, params.c, params.d])(readout);
    } else {
        return null;
    }
};

const bounded = (value, limits) => {
    return limits ? (value > limits.max ? limits.max : value < limits.min ? limits.min : value) : null;
};

const calculateCartridgeHours = (cartridge) => {
    const link = dayjs((cartridge.checkpoints.underway ? cartridge.checkpoints.underway.when : cartridge.checkpoints.linked.when) + '.000Z');
    const fill = dayjs((cartridge.checkpoints.sleeved ? cartridge.checkpoints.sleeved.when : cartridge.checkpoints.released.when) + '.000Z');
    return Math.round(link.diff(fill, 'hour'));
};

export default {
    checksum,
    sqrt3,
    max,
    min,
    between,
    arrayMax,
    arrayMin,
    round,
    dehydrate,
    rangedRand,
    datasetExtent,
    chartExtent,
    combineAndSortNumberArrays,
    linearPredict,
    derivative,
    vectorMagnitude,
    vectorScale,
    vectorAdd,
    vectorSubtract,
    vectorVariance,
    vectorDot,
    vectorSum,
    vectorMean,
    vectorMeanIndexed,
    vectorDistance,
    vectorAbsorption,
    vectorPredict,
    calcLinear,
    invLinear,
    calc3PLC,
    inv3PLC,
    calc4PLCv1,
    inv4PLCv1,
    calc4PLC,
    inv4PLC,
    calcQuadratic,
    invQuadratic,
    channelAPoints,
    channelBPoints,
    channelCPoints,
    channelPoints,
    baselines,
    readings,
    numberOfBaselines,
    baselineTime,
    channelDistanceChange,
    channelAbsorptionChange,
    processChannels,
    inverse,
    calc,
    calculateCartridgeHours
};
