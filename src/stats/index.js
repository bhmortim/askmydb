'use strict';

// Single dispatch point for every statistical method. Routes and the
// recommender call runAnalysis(kind, args) rather than importing methods
// directly, so the set of analyses has one authoritative registry.

const descriptive = require('./descriptive');
const correlation = require('./correlation');
const regression = require('./regression');
const tests = require('./tests');
const outliersMod = require('./outliers');
const timeseries = require('./timeseries');

// Each entry: (args) => result object. args are validated shallowly here.
const REGISTRY = {
  describe: (a) => descriptive.describe(reqArray(a.values, 'values')),
  histogram: (a) => descriptive.histogram(reqArray(a.values, 'values'), a.bins || 0),
  frequency: (a) => descriptive.frequencyTable(reqArray(a.values, 'values'), a.topN || 20),

  pearson: (a) => correlation.pearson(reqArray(a.x, 'x'), reqArray(a.y, 'y'), a),
  spearman: (a) => correlation.spearman(reqArray(a.x, 'x'), reqArray(a.y, 'y'), a),
  correlationMatrix: (a) => correlation.correlationMatrix(reqCols(a.columns), a),

  linearRegression: (a) => regression.simpleLinear(reqArray(a.x, 'x'), reqArray(a.y, 'y')),
  multipleRegression: (a) => regression.multipleLinear(reqMatrix(a.X), reqArray(a.y, 'y'), a.predictorNames || null),

  oneSampleT: (a) => tests.oneSampleT(reqArray(a.values, 'values'), a.mu0 || 0, a),
  twoSampleT: (a) => tests.twoSampleT(reqArray(a.a, 'a'), reqArray(a.b, 'b'), a),
  pairedT: (a) => tests.pairedT(reqArray(a.a, 'a'), reqArray(a.b, 'b'), a),
  chiSquare: (a) => tests.chiSquareTest(reqMatrix(a.table)),
  anova: (a) => tests.oneWayAnova(reqGroups(a.groups)),
  levene: (a) => tests.leveneTest(reqGroups(a.groups)),

  outliers: (a) => outliersMod.outliers(reqArray(a.values, 'values'), a),
  trend: (a) => timeseries.trend(reqArray(a.values, 'values'), a.time || null),
  movingAverage: (a) => timeseries.movingAverage(reqArray(a.values, 'values'), a.window || 3)
};

function reqArray(v, name) {
  if (!Array.isArray(v)) throw new Error(`argument "${name}" must be an array`);
  return v;
}
function reqMatrix(v) {
  if (!Array.isArray(v) || !Array.isArray(v[0])) throw new Error('argument must be a 2-D array');
  return v;
}
function reqCols(v) {
  if (!Array.isArray(v) || !v.every((c) => c && Array.isArray(c.values))) {
    throw new Error('columns must be [{ name, values }]');
  }
  return v;
}
function reqGroups(v) {
  if (!Array.isArray(v) || !v.every(Array.isArray)) throw new Error('groups must be an array of arrays');
  return v;
}

/** Run one analysis. Returns { kind, ...result } or { kind, error }. */
function runAnalysis(kind, args = {}) {
  const fn = REGISTRY[kind];
  if (!fn) return { kind, error: `unknown analysis "${kind}"` };
  try {
    const result = fn(args);
    return { kind, ...result };
  } catch (e) {
    return { kind, error: e.message };
  }
}

function listKinds() {
  return Object.keys(REGISTRY);
}

module.exports = { runAnalysis, listKinds, REGISTRY };
