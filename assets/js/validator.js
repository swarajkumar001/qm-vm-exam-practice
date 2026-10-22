/*
 * Question bank validator.
 * Checks every question and reports problems instead of silently accepting bad data.
 * Questions with errors are excluded from practice; warnings are shown but the question is kept.
 */
(function (root) {
  'use strict';

  var TYPES = ['MSQ', 'MCQ'];
  var DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
  }

  /**
   * @param {object|Array} raw  Parsed JSON: either an array of questions or { meta, questions: [] }.
   * @param {{strictMsq?: boolean}} [options]
   *   strictMsq: when true, an MSQ must have 2+ correct options and at least one incorrect option
   *   (otherwise that rule only produces a warning). Defaults to meta.validation.strictMsq.
   * @returns {{questions: object[], errors: object[], warnings: object[], meta: object, fatal?: string}}
   */
  function validateQuestionBank(raw, options) {
    var result = { questions: [], errors: [], warnings: [], meta: {} };
    var list = raw;

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      result.meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
      list = raw.questions;
    }
    if (!Array.isArray(list)) {
      result.fatal = 'The question bank must be an array of questions, or an object with a "questions" array.';
      return result;
    }

    var strictMsq = options && typeof options.strictMsq === 'boolean'
      ? options.strictMsq
      : !!(result.meta.validation && result.meta.validation.strictMsq);

    var seenIds = Object.create(null);

    list.forEach(function (q, index) {
      var errors = [];
      var warnings = [];
      var label = q && isNonEmptyString(q.id) ? q.id : 'entry #' + (index + 1);

      if (!q || typeof q !== 'object' || Array.isArray(q)) {
        result.errors.push({ id: label, index: index, messages: ['Entry is not a question object.'] });
        return;
      }

      // id
      if (!isNonEmptyString(q.id)) {
        errors.push('Missing "id".');
      } else if (seenIds[q.id] !== undefined) {
        errors.push('Duplicate id — also used by entry #' + (seenIds[q.id] + 1) + '.');
      } else {
        seenIds[q.id] = index;
      }

      // type
      if (TYPES.indexOf(q.type) === -1) {
        errors.push('"type" must be "MSQ" or "MCQ" (got ' + JSON.stringify(q.type) + ').');
      }

      // question text
      if (!isNonEmptyString(q.question)) errors.push('Missing "question" text.');

      // options
      var optionIds = [];
      if (!Array.isArray(q.options) || q.options.length < 2) {
        errors.push('"options" must be an array with at least 2 options.');
      } else {
        q.options.forEach(function (o, i) {
          if (!o || typeof o !== 'object') {
            errors.push('Option ' + (i + 1) + ' is not an object.');
            return;
          }
          if (!isNonEmptyString(o.id)) errors.push('Option ' + (i + 1) + ' has no "id".');
          else if (optionIds.indexOf(o.id) !== -1) errors.push('Duplicate option id "' + o.id + '".');
          else optionIds.push(o.id);
          if (!isNonEmptyString(o.text)) errors.push('Option ' + (i + 1) + ' has no "text".');
        });
        if (q.options.length !== 4) warnings.push('Has ' + q.options.length + ' options (4 recommended).');
      }

      // answer key
      var answers = q.correctAnswers;
      if (!Array.isArray(answers) || answers.length === 0) {
        errors.push('"correctAnswers" must be a non-empty array of option ids.');
      } else {
        var unique = [];
        answers.forEach(function (a) {
          if (unique.indexOf(a) !== -1) errors.push('"correctAnswers" lists "' + a + '" twice.');
          else unique.push(a);
          if (optionIds.length && optionIds.indexOf(a) === -1) {
            errors.push('Answer "' + a + '" does not match any option id.');
          }
        });
        if (q.type === 'MCQ' && answers.length !== 1) {
          errors.push('An MCQ must have exactly 1 correct answer (has ' + answers.length + ').');
        }
        if (q.type === 'MSQ' && optionIds.length) {
          var issue = null;
          if (unique.length < 2) issue = 'MSQ has only ' + unique.length + ' correct option (2+ expected).';
          else if (unique.length >= optionIds.length) issue = 'MSQ marks every option correct (no incorrect option).';
          if (issue) (strictMsq ? errors : warnings).push(issue);
        }
      }

      // explanation
      if (!isNonEmptyString(q.explanation)) errors.push('Missing "explanation".');
      if (q.optionExplanations != null) {
        if (typeof q.optionExplanations !== 'object' || Array.isArray(q.optionExplanations)) {
          errors.push('"optionExplanations" must be an object keyed by option id.');
        } else {
          Object.keys(q.optionExplanations).forEach(function (k) {
            if (optionIds.length && optionIds.indexOf(k) === -1) {
              warnings.push('optionExplanations has key "' + k + '" that is not an option id.');
            }
          });
        }
      }

      // optional metadata
      if (!isNonEmptyString(q.topic)) warnings.push('Missing "topic" (shown as "General").');
      if (q.difficulty != null && DIFFICULTIES.indexOf(q.difficulty) === -1) {
        warnings.push('"difficulty" should be Easy, Medium or Hard (got ' + JSON.stringify(q.difficulty) + ').');
      }
      if (q.source != null) {
        if (typeof q.source !== 'object' || Array.isArray(q.source)) {
          errors.push('"source" must be an object like {"file": "...", "page": 5}.');
        } else if (q.source.page != null && !(Number.isInteger(q.source.page) && q.source.page > 0)) {
          warnings.push('"source.page" should be a positive whole number.');
        }
      }

      if (errors.length) result.errors.push({ id: label, index: index, messages: errors });
      else result.questions.push(q);
      if (warnings.length) result.warnings.push({ id: label, index: index, messages: warnings });
    });

    if (!result.questions.length) result.fatal = 'The question bank contains no valid questions.';
    return result;
  }

  var api = { validateQuestionBank: validateQuestionBank, TYPES: TYPES, DIFFICULTIES: DIFFICULTIES };
  root.QuestionValidator = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
