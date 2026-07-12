'use strict';

const { cleanPairs, mean } = require('./descriptive');
const { studentTCdf, twoTailedFromCdf, fCdf } = require('./distributions');
const { transpose, matMul, cholesky, choleskySolve, invFromCholesky, gaussianSolve } = require('./matrix');

/** Simple OLS: y = intercept + slope·x, with inference. */
function simpleLinear(xsRaw, ysRaw) {
  const { x, y } = cleanPairs(xsRaw, ysRaw);
  const n = x.length;
  if (n < 3) return { error: 'need at least 3 complete pairs', n };
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    sxx += dx * dx;
    sxy += dx * (y[i] - my);
    syy += (y[i] - my) * (y[i] - my);
  }
  if (sxx === 0) return { error: 'predictor has zero variance', n };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  let sse = 0;
  for (let i = 0; i < n; i++) {
    const resid = y[i] - (intercept + slope * x[i]);
    sse += resid * resid;
  }
  const df = n - 2;
  const mse = sse / df;
  const seSlope = Math.sqrt(mse / sxx);
  const seIntercept = Math.sqrt(mse * (1 / n + (mx * mx) / sxx));
  const tSlope = slope / seSlope;
  const pSlope = twoTailedFromCdf(studentTCdf(tSlope, df), 2);
  const r2 = syy === 0 ? NaN : 1 - sse / syy;

  return {
    kind: 'linearRegression', n, df,
    intercept, slope,
    seSlope, seIntercept, tSlope, pSlope,
    r2,
    adjR2: 1 - (1 - r2) * (n - 1) / (n - 2),
    rmse: Math.sqrt(sse / n),
    equation: `y = ${round(intercept)} + ${round(slope)}·x`,
    predict: undefined // filled below
  };
}

/**
 * Multiple OLS. X: [[x1,x2,...], ...] predictor rows, y: response.
 * predictorNames optional. Returns coefficients (incl. intercept), SEs, t, p,
 * R², adjusted R², overall F, and a collinearity flag.
 */
function multipleLinear(Xraw, yRaw, predictorNames = null) {
  // clean row-wise: drop rows with any non-finite value
  const rows = [];
  const ys = [];
  const nCols = Xraw[0] ? Xraw[0].length : 0;
  for (let i = 0; i < Xraw.length; i++) {
    const xr = Xraw[i].map(Number);
    const yv = Number(yRaw[i]);
    if (xr.every(Number.isFinite) && Number.isFinite(yv)) { rows.push(xr); ys.push(yv); }
  }
  const n = rows.length;
  const k = nCols; // predictors (excluding intercept)
  if (n < k + 2) return { error: `need at least ${k + 2} complete rows for ${k} predictors`, n };

  // design matrix with intercept column
  const X = rows.map((r) => [1, ...r]);
  const p = k + 1;
  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  const Xty = matMul(Xt, ys.map((v) => [v])).map((r) => r[0]);

  const L = cholesky(XtX);
  let beta;
  let XtXinv;
  let collinear = false;
  if (L) {
    beta = choleskySolve(L, Xty);
    XtXinv = invFromCholesky(L);
  } else {
    // fall back to Gaussian elimination; flag likely collinearity
    collinear = true;
    beta = gaussianSolve(XtX, Xty);
    if (!beta) return { error: 'design matrix is singular (perfectly collinear predictors)', n };
    XtXinv = null;
  }

  const my = mean(ys);
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    let yhat = beta[0];
    for (let j = 0; j < k; j++) yhat += beta[j + 1] * rows[i][j];
    sse += (ys[i] - yhat) ** 2;
    sst += (ys[i] - my) ** 2;
  }
  const dfResid = n - p;
  const mse = sse / dfResid;
  const r2 = sst === 0 ? NaN : 1 - sse / sst;
  const adjR2 = 1 - (1 - r2) * (n - 1) / dfResid;

  const names = ['(intercept)', ...(predictorNames || Array.from({ length: k }, (_, i) => `x${i + 1}`))];
  const coefficients = beta.map((b, j) => {
    let se = NaN;
    let t = NaN;
    let pv = NaN;
    if (XtXinv) {
      se = Math.sqrt(Math.max(0, XtXinv[j][j] * mse));
      t = b / se;
      pv = twoTailedFromCdf(studentTCdf(t, dfResid), 2);
    }
    return { name: names[j], estimate: b, stdError: se, t, p: pv };
  });

  // overall F test
  const dfModel = k;
  const f = ((sst - sse) / dfModel) / mse;
  const fp = 1 - fCdf(f, dfModel, dfResid);

  return {
    kind: 'multipleRegression', n, k,
    coefficients, r2, adjR2, rmse: Math.sqrt(sse / n),
    f, fPValue: fp, dfModel, dfResid, collinear
  };
}

function round(v) { return Math.round(v * 1e4) / 1e4; }

module.exports = { simpleLinear, multipleLinear };
