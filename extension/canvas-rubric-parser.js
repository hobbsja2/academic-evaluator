(() => {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  const RUBRIC_SELECTORS = [
    '#rubric_full',
    '#rubric_holder',
    '#rubric',
    '.rubric_table',
    '[data-testid="rubric"]',
    '[data-testid="rubric-table"]',
    '[data-testid="rubric-assessment"]',
    '.rubric-assessment',
    'table[class~="rubric"]'
  ];
  const CRITERION_SELECTORS = [
    'tr.criterion',
    'tr.rubric-criterion',
    '.rubric-criterion[role="row"]',
    '[role="row"][data-criterion-id]',
    '[role="row"][data-testid="rubric-criterion"]',
    '[role="row"][data-testid="rubric-criterion-row"]',
    '[role="row"][data-testid*="criterion"]',
    '[role="listitem"][data-testid="rubric-criterion"]',
    '[role="listitem"][data-testid*="criterion"]',
    'section[data-testid="rubric-criterion"]',
    '[data-testid="rubric-criterion-row"]',
    '[data-testid="rubric-criterion"][data-criterion-id]',
    'tr[data-criterion-id]',
    'tr[id^="criterion_"]',
    'div.criterion[data-criterion-id]',
    'div.criterion[id^="criterion_"]'
  ];
  const RATING_SELECTORS = [
    '.ratings > .rating',
    'td.rating',
    '.rubric-rating',
    '[role="listitem"][data-testid="rubric-rating"]',
    '[role="listitem"][data-testid="rating-card"]',
    '[role="listitem"][data-testid*="rating"]',
    '[role="radio"][data-testid="rubric-rating"]',
    '[role="radio"][data-testid*="rating"]',
    '[role="radio"][data-rating-id]',
    '[data-testid="rubric-rating"][data-rating-id]',
    '[data-testid="rating-card"][data-rating-id]',
    'button[data-rating-id]',
    'td[data-rating-id]'
  ];

  function firstMatch(root, selectors) {
    for (const selector of selectors) {
      try {
        const node = root.querySelector(selector);
        if (node) return { node, selector };
      } catch {
        // Ignore unsupported selectors so capture fails safely on older embedded browsers.
      }
    }
    return { node: null, selector: null };
  }

  function uniqueMatches(root, selectors) {
    const nodes = [];
    const seen = new Set();
    const matchedSelectors = [];
    for (const selector of selectors) {
      let matches = [];
      try {
        matches = [...root.querySelectorAll(selector)];
      } catch {
        continue;
      }
      if (matches.length) matchedSelectors.push(selector);
      for (const node of matches) {
        if (!seen.has(node)) {
          seen.add(node);
          nodes.push(node);
        }
      }
    }
    return { nodes, matchedSelectors };
  }

  const text = (root, selectors) => clean(firstMatch(root, selectors).node?.textContent);

  function isExplicitlyHidden(node) {
    for (let current = node; current instanceof Element; current = current.parentElement) {
      if (current.matches('template, [hidden], [aria-hidden="true"]')) return true;
      if (current.style?.display === 'none' || current.style?.visibility === 'hidden') return true;
      if (current === document.documentElement) break;
    }
    return false;
  }

  function outermost(nodes) {
    return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
  }

  function stableId(node, kind, fallback) {
    return clean(
      node.getAttribute('id') ||
      node.getAttribute('data-id') ||
      node.getAttribute(`data-${kind}-id`)
    ) || fallback;
  }

  function pointValue(candidates) {
    let invalid = false;
    for (const candidate of candidates) {
      const value = clean(candidate.value).replace(/,/g, '');
      if (!value) continue;
      const pointsMatch = value.match(/(-?\d+(?:\.\d+)?)\s*(?:points?|pts?)\b/i);
      const genericMatch = candidate.explicit ? value.match(/-?\d+(?:\.\d+)?/) : null;
      const match = pointsMatch || genericMatch;
      if (!match) {
        if (candidate.explicit) invalid = true;
        continue;
      }
      const parsed = Number(match[1] ?? match[0]);
      if (Number.isFinite(parsed) && parsed >= 0) return { value: parsed, invalid };
      invalid = true;
    }
    return { value: null, invalid };
  }

  function pointsFrom(root, selectors, rootAttributes = []) {
    const candidates = rootAttributes.map((attribute) => ({
      value: root.getAttribute(attribute),
      explicit: true
    }));
    const { nodes } = uniqueMatches(root, selectors);
    for (const node of nodes) {
      for (const attribute of ['data-points', 'data-value', 'value', 'aria-label', 'title']) {
        if (node.hasAttribute(attribute)) {
          candidates.push({ value: node.getAttribute(attribute), explicit: true });
        }
      }
      candidates.push({ value: node.textContent, explicit: false });
    }
    return pointValue(candidates);
  }

  function safeUrlDetails(value) {
    try {
      const url = new URL(value);
      const decode = (part) => {
        if (!part) return null;
        try {
          return clean(decodeURIComponent(part)) || null;
        } catch {
          return null;
        }
      };
      const courseId = decode(url.pathname.match(/\/courses\/([^/]+)/i)?.[1]);
      const pathAssignmentId = decode(url.pathname.match(/\/assignments\/([^/]+)/i)?.[1]);
      const queryAssignmentId = decode(
        url.searchParams.get('assignment_id') || url.searchParams.get('assignmentId')
      );
      url.search = '';
      url.hash = '';
      return {
        courseId,
        assignmentId: pathAssignmentId || queryAssignmentId,
        sourceUrl: `${url.origin}${url.pathname}`
      };
    } catch {
      return { courseId: null, assignmentId: null, sourceUrl: null };
    }
  }

  function namesFromPage() {
    const courseName = clean(
      document.querySelector('meta[name="canvas-course-name"]')?.content ||
      text(document, [
        '#crumb_course',
        '#course_name',
        '.ic-app-crumbs a[href*="/courses/"]',
        '[data-testid="course-name"]',
        '[data-testid="speedgrader-course-name"]',
        '.course-title'
      ])
    );
    const assignmentName = clean(
      document.querySelector('meta[name="canvas-assignment-name"]')?.content ||
      text(document, [
        '#assignment_show h1',
        '#assignment_show .title',
        '#assignment_name',
        '.assignment_name',
        '[data-testid="assignment-name"]',
        '[data-testid="speedgrader-assignment-name"]',
        'h1.assignment-title',
        'main h1'
      ])
    );
    return { courseName: courseName || null, assignmentName: assignmentName || null };
  }

  function parseRating(node, index, criterionId) {
    const name = text(node, [
      '.rating_description',
      '.rating-title',
      '.rating_name',
      '[data-testid="rating-name"]',
      '[data-testid="rating-title"]',
      '[data-testid="rubric-rating-name"]',
      '[role="heading"]',
      'h4',
      'h3'
    ]);
    const description = text(node, [
      '.rating_long_description',
      '.long_description',
      '.rating-long-description',
      '.rating-description-long',
      '[data-testid="rating-long-description"]',
      '[data-testid="rubric-rating-description"]',
      '[data-testid="rating-description"]',
      '[data-testid="rating-details"]'
    ]);
    const parsedPoints = pointsFrom(node, [
      '.points',
      '.rating_points',
      '.rating-points',
      '.point_value',
      '[data-testid="rating-points"]',
      '[data-testid="rubric-rating-points"]',
      '[data-points]'
    ], ['data-points', 'data-value']);
    const data = {
      id: stableId(node, 'rating', `${criterionId}-rating-${index + 1}`),
      name: name || null,
      description: description || null,
      points: parsedPoints.value
    };
    return {
      data,
      meaningful: Boolean(data.name || data.description || data.points !== null),
      missingDescription: !data.description,
      invalidPoint: parsedPoints.invalid
    };
  }

  function criterionText(node) {
    return {
      name: text(node, [
        '.criterion_description',
        '.description .name',
        '.criterion-title',
        '.criterion_name',
        '[data-testid="criterion-name"]',
        '[data-testid="criterion-title"]',
        '[data-testid="rubric-criterion-name"]',
        'th .description',
        '[role="rowheader"] [role="heading"]',
        '[role="rowheader"] h3',
        '[role="rowheader"] h4'
      ]),
      description: text(node, [
        '.criterion_long_description',
        '.long_description',
        '.criterion-long-description',
        '.criterion-description-long',
        '.description_details',
        '[data-testid="criterion-long-description"]',
        '[data-testid="rubric-criterion-description"]',
        '[data-testid="criterion-description"]',
        '[data-testid="criterion-details"]'
      ])
    };
  }

  function criterionRatings(node, criterionId) {
    const matches = uniqueMatches(node, RATING_SELECTORS);
    const candidates = matches.nodes.filter((candidate) => !isExplicitlyHidden(candidate));
    return outermost(candidates).map((rating, index) =>
      parseRating(rating, index, criterionId)
    );
  }

  function criterionMaximum(node, ratings) {
    const explicit = pointsFrom(node, [
      '.criterion_points',
      '.criterion-points',
      '.points_possible',
      '.points-possible',
      '[data-testid="criterion-points"]',
      '[data-testid="criterion-points-possible"]',
      '[data-testid="rubric-criterion-points"]',
      'td.points_possible',
      'td.criterion_points'
    ], ['data-points-possible', 'data-max-points']);
    const ratingPoints = ratings.map((rating) => rating.points).filter(Number.isFinite);
    return {
      explicit,
      value: explicit.value ?? (ratingPoints.length ? Math.max(...ratingPoints) : null)
    };
  }

  function parseCriterion(node, index) {
    const criterionId = stableId(node, 'criterion', `criterion-${index + 1}`);
    const criterionCopy = criterionText(node);
    const parsedRatings = criterionRatings(node, criterionId);
    const ratings = parsedRatings.filter((rating) => rating.meaningful).map((rating) => rating.data);
    const maximum = criterionMaximum(node, ratings);
    const data = {
      id: criterionId,
      name: criterionCopy.name || null,
      description: criterionCopy.description || null,
      maximumPoints: maximum.value,
      ratings
    };
    return {
      data,
      meaningful: Boolean(data.name || data.description || data.ratings.length),
      malformed: !data.name && !data.description,
      missingRatings: data.ratings.length === 0,
      missingMaximum: maximum.explicit.value === null,
      missingRatingDescriptions: parsedRatings.filter((rating) =>
        rating.meaningful && rating.missingDescription
      ).length,
      invalidPointCount: Number(maximum.explicit.invalid) + parsedRatings.filter((rating) =>
        rating.invalidPoint
      ).length
    };
  }

  function warningMessages(diagnostics) {
    const warnings = [];
    if (diagnostics.malformedCriterionCount) {
      warnings.push(`${diagnostics.malformedCriterionCount} criterion candidate(s) lacked readable criterion text.`);
    }
    if (diagnostics.missingRatingCount) {
      warnings.push(`${diagnostics.missingRatingCount} criterion/criteria had no readable ratings.`);
    }
    if (diagnostics.missingRatingDescriptionCount) {
      warnings.push(`${diagnostics.missingRatingDescriptionCount} rating(s) lacked descriptor text.`);
    }
    if (diagnostics.missingMaximumPointsCount) {
      warnings.push(`${diagnostics.missingMaximumPointsCount} criterion/criteria lacked explicit maximum points.`);
    }
    if (diagnostics.invalidPointCount) {
      warnings.push(`${diagnostics.invalidPointCount} invalid point value(s) were ignored.`);
    }
    return warnings;
  }

  function locateRubric() {
    for (const selector of RUBRIC_SELECTORS) {
      let matches = [];
      try {
        matches = [...document.querySelectorAll(selector)];
      } catch {
        continue;
      }
      const node = matches.find((candidate) => !isExplicitlyHidden(candidate));
      if (node) return { node, selector };
    }
    return { node: null, selector: null };
  }

  function createDiagnostics() {
    return {
      rubricSelector: null,
      criterionSelector: null,
      criterionCandidateCount: 0,
      parsedCriterionCount: 0,
      ratingCount: 0,
      malformedCriterionCount: 0,
      missingRatingCount: 0,
      missingRatingDescriptionCount: 0,
      missingMaximumPointsCount: 0,
      invalidPointCount: 0,
      totalSource: 'missing'
    };
  }

  function failure(error, diagnostics) {
    return { ok: false, error, diagnostics };
  }

  function readCriteria(rubric, diagnostics) {
    const matches = uniqueMatches(rubric, CRITERION_SELECTORS);
    const candidates = matches.nodes.filter((node) => !isExplicitlyHidden(node));
    const parsed = outermost(candidates).map(parseCriterion);
    const usable = parsed.filter((criterion) => criterion.meaningful);
    const criteria = usable.map((criterion) => criterion.data);
    Object.assign(diagnostics, {
      criterionSelector: matches.matchedSelectors.join(', ') || null,
      criterionCandidateCount: candidates.length,
      parsedCriterionCount: criteria.length,
      ratingCount: usable.reduce((sum, criterion) => sum + criterion.data.ratings.length, 0),
      malformedCriterionCount: parsed.filter((criterion) => criterion.malformed).length,
      missingRatingCount: usable.filter((criterion) => criterion.missingRatings).length,
      missingRatingDescriptionCount: usable.reduce((sum, criterion) =>
        sum + criterion.missingRatingDescriptions, 0),
      missingMaximumPointsCount: usable.filter((criterion) => criterion.missingMaximum).length,
      invalidPointCount: usable.reduce((sum, criterion) => sum + criterion.invalidPointCount, 0)
    });
    return criteria;
  }

  function readTotal(rubric, criteria, diagnostics) {
    const explicit = pointsFrom(rubric, [
      '#rubric_total',
      '.rubric_total',
      '.total_points',
      '.rubric-total',
      '[data-testid="rubric-total"]',
      '[data-testid="rubric-total-points"]'
    ], ['data-total-points']);
    if (explicit.invalid) diagnostics.invalidPointCount += 1;
    if (explicit.value !== null) {
      diagnostics.totalSource = 'explicit';
      return explicit.value;
    }
    const maximums = criteria.map((criterion) => criterion.maximumPoints).filter(Number.isFinite);
    if (maximums.length === criteria.length) {
      diagnostics.totalSource = 'criterion-sum';
      return maximums.reduce((sum, value) => sum + value, 0);
    }
    return null;
  }

  function successfulCapture(rubric, criteria, diagnostics) {
    const urlDetails = safeUrlDetails(location.href);
    const rubricTitle = text(rubric, [
      '.rubric_title',
      '.rubric-title',
      '[data-testid="rubric-title"]',
      'caption',
      '[role="heading"]'
    ]);
    return {
      ok: true,
      data: {
        courseId: urlDetails.courseId,
        assignmentId: urlDetails.assignmentId,
        ...namesFromPage(),
        rubricTitle: rubricTitle || null,
        criteria,
        totalPoints: readTotal(rubric, criteria, diagnostics),
        sourceUrl: urlDetails.sourceUrl,
        capturedAt: new Date().toISOString()
      },
      diagnostics,
      warnings: warningMessages(diagnostics)
    };
  }

  function captureRubric(diagnostics) {
    const located = locateRubric();
    diagnostics.rubricSelector = located.selector;
    if (!located.node) {
      return failure(
        'No readable rubric was found. Open or expand the assignment rubric and try again.',
        diagnostics
      );
    }
    const criteria = readCriteria(located.node, diagnostics);
    if (!criteria.length) {
      return failure('A rubric container was found, but it had no readable criteria.', diagnostics);
    }
    if (criteria.every((criterion) => !criterion.name && !criterion.description)) {
      return failure('Rubric criteria were missing readable names or descriptions.', diagnostics);
    }
    return successfulCapture(located.node, criteria, diagnostics);
  }

  function capture() {
    const diagnostics = createDiagnostics();
    try {
      return captureRubric(diagnostics);
    } catch {
      return failure('Could not read this rubric.', diagnostics);
    }
  }

  globalThis.captureCanvasRubric = capture;
})();
