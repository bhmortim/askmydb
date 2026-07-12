'use strict';

// Deterministic analysis recommender. Given a column profile and the user's
// question, it ranks which analyses fit and templates a data-grounded WHY.
// This is the source of truth for WHAT runs and WHY — the LLM only rephrases,
// never decides. Keeping it rule-based makes it explainable and testable, and
// it works even when the local model is weak or offline.

const CAUSATION_CAVEAT = 'Correlation does not imply causation — a relationship here does not prove one variable drives the other.';

/**
 * @param profile  output of profileColumns()
 * @param question the user's natural-language question (optional, for keyword bias)
 * @returns ranked [{ kind, title, columns, score, rationale, assumptions, caveats, requiresConfirm }]
 */
function recommendAnalyses(profile, question = '', { maxSuggestions = 5 } = {}) {
  const q = String(question).toLowerCase();
  const kw = (words) => words.some((w) => q.includes(w));
  const n = profile.nRows;
  const { measures, dimensions, dates, columns } = profile;
  const out = [];

  const smallN = n < 15;
  const nNote = smallN ? ` Sample is small (n=${n}), so treat results as exploratory.` : '';

  // --- correlation between two measures ---
  if (measures.length >= 2) {
    const [a, b] = measures;
    let score = 60 + (n >= 15 ? 15 : 0);
    if (kw(['correlat', 'relationship', 'related', 'associat', 'linked', 'depend', 'vs', 'versus'])) score += 25;
    out.push({
      kind: 'pearson',
      title: `Correlation: ${a.name} vs ${b.name}`,
      columns: { x: a.name, y: b.name },
      score,
      rationale: `Both ${a.name} and ${b.name} are numeric measures over ${n} rows, so a Pearson correlation quantifies whether they move together.${nNote}`,
      assumptions: ['roughly linear relationship', 'approximately normal, no extreme outliers'],
      caveats: [CAUSATION_CAVEAT]
    });
    // regression when a question implies prediction/effect
    if (kw(['predict', 'driv', 'effect', 'impact', 'explain', 'depend', 'model'])) {
      out.push({
        kind: 'linearRegression',
        title: `Linear regression: ${b.name} on ${a.name}`,
        columns: { x: a.name, y: b.name },
        score: score - 5,
        rationale: `Your question implies estimating how ${b.name} changes with ${a.name}; a linear regression gives the slope, its significance, and R².${nNote}`,
        assumptions: ['linearity', 'independent, homoscedastic residuals'],
        caveats: [CAUSATION_CAVEAT]
      });
    }
    // multi-measure correlation matrix
    if (measures.length >= 3) {
      out.push({
        kind: 'correlationMatrix',
        title: `Correlation matrix of ${measures.length} measures`,
        columns: { measures: measures.map((m) => m.name) },
        score: 55,
        rationale: `There are ${measures.length} numeric measures; a correlation matrix surfaces the strongest pairwise relationships at a glance.`,
        assumptions: ['pairwise linear relationships'],
        caveats: [CAUSATION_CAVEAT, 'Many pairs are tested at once — adjust for multiple comparisons before trusting any single small p-value.']
      });
    }
  }

  // --- group comparison: a measure split by a low-cardinality dimension ---
  if (measures.length >= 1 && dimensions.length >= 1) {
    const m = measures[0];
    const dim = dimensions.find((d) => d.cardinality >= 2 && d.cardinality <= 30) || dimensions[0];
    if (dim && dim.cardinality >= 2) {
      const twoGroups = dim.cardinality === 2;
      let score = 58 + (n >= 20 ? 12 : 0);
      if (kw(['compare', 'differ', 'between', 'group', 'higher', 'lower', 'more than', 'by '])) score += 22;
      out.push({
        kind: twoGroups ? 'twoSampleT' : 'anova',
        title: `Compare ${m.name} across ${dim.name}`,
        columns: { value: m.name, group: dim.name },
        score,
        rationale: twoGroups
          ? `${m.name} is numeric and ${dim.name} has two groups, so a two-sample t-test checks whether their means differ.${nNote}`
          : `${m.name} is numeric and ${dim.name} has ${dim.cardinality} groups, so a one-way ANOVA checks whether any group means differ.${nNote}`,
        assumptions: twoGroups
          ? ['approximately normal within each group']
          : ['approximately normal within groups', 'similar variance across groups'],
        caveats: []
      });
    }
  }

  // --- trend over time ---
  if (measures.length >= 1 && dates.length >= 1 && n >= 4) {
    const m = measures[0];
    const d = dates[0];
    let score = 62;
    if (kw(['trend', 'over time', 'grow', 'decline', 'increas', 'decreas', 'season', 'time'])) score += 25;
    out.push({
      kind: 'trend',
      title: `Trend of ${m.name} over ${d.name}`,
      columns: { value: m.name, time: d.name },
      score,
      rationale: `${m.name} is numeric and ${d.name} is a time column, so a trend test (robust Theil–Sen slope + Mann–Kendall) shows whether it is rising or falling over time.`,
      assumptions: ['observations ordered in time'],
      caveats: ['A monotonic trend test does not model seasonality.']
    });
  }

  // --- association between two categorical dimensions ---
  const catDims = dimensions.filter((d) => d.inferredType !== 'numeric' && d.cardinality >= 2 && d.cardinality <= 20);
  if (catDims.length >= 2) {
    const [a, b] = catDims;
    let score = 50;
    if (kw(['associat', 'independ', 'relationship', 'depend'])) score += 20;
    out.push({
      kind: 'chiSquare',
      title: `Association: ${a.name} × ${b.name}`,
      columns: { rows: a.name, cols: b.name },
      score,
      rationale: `${a.name} and ${b.name} are both categorical, so a chi-square test of independence checks whether they are associated.`,
      assumptions: ['expected count ≥ 5 in most cells'],
      caveats: [CAUSATION_CAVEAT],
      requiresConfirm: true // needs a contingency table built first
    });
  }

  // --- distribution / outliers for a single measure ---
  if (measures.length >= 1) {
    const m = measures[0];
    out.push({
      kind: 'describe',
      title: `Distribution of ${m.name}`,
      columns: { values: m.name },
      score: 40,
      rationale: `Summarize the center, spread, and shape of ${m.name} (mean, median, quartiles, skew) before deeper analysis.`,
      assumptions: [],
      caveats: []
    });
    if (n >= 8) {
      out.push({
        kind: 'outliers',
        title: `Outliers in ${m.name}`,
        columns: { values: m.name },
        score: 38,
        rationale: `Flag unusually large/small values of ${m.name} (1.5·IQR and modified z-score) that could distort other analyses.`,
        assumptions: [],
        caveats: []
      });
    }
  }

  // rank, de-dupe by kind+columns, cap
  const seen = new Set();
  return out
    .sort((x, y) => y.score - x.score)
    .filter((r) => {
      const key = r.kind + JSON.stringify(r.columns);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxSuggestions);
}

module.exports = { recommendAnalyses, CAUSATION_CAVEAT };
