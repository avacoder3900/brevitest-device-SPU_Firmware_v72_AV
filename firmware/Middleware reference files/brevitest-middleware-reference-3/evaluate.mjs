import util from './utilities.mjs';

export default (cartridge) => {
    const round = util.round;
    const derivative = util.derivative;
    const vectorMagnitude = util.vectorMagnitude;
    const vectorScale = util.vectorScale;
    const vectorAdd = util.vectorAdd;
    const vectorSubtract = util.vectorSubtract;
    const vectorVariance = util.vectorVariance;
    const vectorDot = util.vectorDot;
    const vectorSum = util.vectorSum;
    const vectorMean = util.vectorMean;
    const vectorMeanIndexed = util.vectorMeanIndexed;
    const vectorDistance = util.vectorDistance;
    const vectorAbsorption = util.vectorAbsorption;
    const vectorPredict = util.vectorPredict;
    const channelAPoints = util.channelAPoints;
    const channelBPoints = util.channelBPoints;
    const channelCPoints = util.channelCPoints;
    const channelPoints = util.channelPoints;
    const baselines = util.baselines;
    const readings = util.readings;
    const numberOfBaselines = util.numberOfBaselines;
    const baselineTime = util.baselineTime;
    const channelDistanceChange = util.channelDistanceChange;
    const channelAbsorptionChange = util.channelAbsorptionChange;
    const processChannels = util.processChannels;
    const inverse = util.inverse;
    const calc = util.calc;
    const estimate = util.estimate;
    const estimateSigma = util.estimateSigma;
    const estimateStdev = util.estimateStdev;
    const estimateAdjustedStdev = util.estimateAdjustedStdev;
    const calculateCartridgeHours = util.calculateCartridgeHours;
    const estimateConcentration = util.estimateConcentration;
    const channelConcentration = util.channelConcentration;
    const concentrationAtTime = util.concentrationAtTime;
    const stats = util.stats;

    const argType = typeof cartridge;
    if (argType === 'string') {
        return eval(`"use strict"; ${cartridge}`);
    } else if (argType === 'object') {
        const fcns = cartridge && cartridge.assay && cartridge.assay.functions;
        if (fcns) {
            if (fcns.calculation) {
                if (fcns.calculation.code) {
                    return eval(`"use strict"; ${fcns.calculation.code}`)(cartridge, cartridge.assay);
                } else {
                    return null;
                }
            } else if (cartridge.sample) {
                if (cartridge.sample.department === 'quality') {
                    return eval(`"use strict"; ${fcns.quality.code}`)(cartridge, cartridge.assay);
                } else {
                    return eval(`"use strict"; ${fcns.sample}`)(cartridge);
                }
            } else if (cartridge.control) {
                return eval(`"use strict"; ${fcns.control}`)(cartridge);
            } else if (cartridge.calibrator) {
                return eval(`"use strict"; ${fcns.calibrator}`)(cartridge);
            }
        } else {
            return null;
        }
    } else {
        return null;
    }
};
