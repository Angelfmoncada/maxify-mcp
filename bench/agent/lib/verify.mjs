// Task verification, both ways, with no Claude involved:
//   after setup only          the hidden test must FAIL (on assertions, not on a crash)
//   after setup + solution    the hidden test and the visible suite must PASS
// Question tasks: the reference answer must satisfy the rubric and the wrong answer must not.
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { evaluateAnswer, listVisibleTests, runNodeTests } from './checks.mjs';
import { applyPatch, createWorkspace, removeTree } from './workspace.mjs';
import { errorMessage, makeTempRoot } from './util.mjs';

function step(name, ok, detail = '') {
  return { name, ok, detail };
}

function summarize(result) {
  return `exit ${result.exitCode}, pass ${result.pass}, fail ${result.fail}${result.crashed ? ', no TAP summary (crash?)' : ''}`;
}

function runHidden(task, dir) {
  const target = path.join(dir, 'test', task.hiddenTestName);
  copyFileSync(task.hiddenTest, target);
  const result = runNodeTests(dir, [`test/${task.hiddenTestName}`]);
  rmSync(target, { force: true });
  return result;
}

function verifyCodeTask(task, tempRoot) {
  const steps = [];
  const dir = createWorkspace({ tempRoot, setupPatch: task.setupPatch });

  const hiddenBefore = runHidden(task, dir);
  steps.push(
    step(
      'hidden test fails after setup only',
      !hiddenBefore.passed && !hiddenBefore.crashed && (hiddenBefore.fail ?? 0) > 0,
      summarize(hiddenBefore),
    ),
  );
  const visibleBefore = runNodeTests(dir, listVisibleTests(dir, task.hiddenTestName));
  const expectVisibleFail = task.expect.visibleFailsAfterSetup;
  steps.push(
    step(
      expectVisibleFail ? 'visible suite fails after setup' : 'visible suite still passes after setup',
      expectVisibleFail ? !visibleBefore.passed && !visibleBefore.crashed : visibleBefore.passed,
      summarize(visibleBefore),
    ),
  );

  applyPatch(dir, task.solutionPatch);
  const hiddenAfter = runHidden(task, dir);
  steps.push(step('hidden test passes after setup + solution', hiddenAfter.passed, summarize(hiddenAfter)));
  const visibleAfter = runNodeTests(dir, listVisibleTests(dir, task.hiddenTestName));
  steps.push(step('visible suite passes after setup + solution', visibleAfter.passed, summarize(visibleAfter)));
  if (!hiddenAfter.passed) steps.push(step('hidden test output (tail)', false, hiddenAfter.outputTail));
  return steps;
}

function verifyQuestionTask(task) {
  const reference = evaluateAnswer(readFileSync(task.referenceAnswer, 'utf8'), task.answerChecks);
  const wrong = evaluateAnswer(readFileSync(task.wrongAnswer, 'utf8'), task.answerChecks);
  return [
    step('reference answer satisfies the rubric', reference.passed, reference.failures.join('; ')),
    step('wrong answer is rejected by the rubric', !wrong.passed, wrong.passed ? 'the wrong answer passed' : wrong.failures.join('; ')),
  ];
}

/** Verifies one loaded task in a throw-away workspace. Never throws. */
export function verifyTask(task) {
  const tempRoot = makeTempRoot('mxv');
  try {
    const steps = task.category === 'question' ? verifyQuestionTask(task) : verifyCodeTask(task, tempRoot);
    return { id: task.id, ok: steps.every((entry) => entry.ok), steps };
  } catch (error) {
    return { id: task.id, ok: false, steps: [step('verification ran', false, errorMessage(error))] };
  } finally {
    removeTree(tempRoot);
  }
}

/** The unmodified fixture must pass its own visible suite. */
export function verifyBaseline() {
  const tempRoot = makeTempRoot('mxv');
  try {
    const dir = createWorkspace({ tempRoot, setupPatch: null });
    const result = runNodeTests(dir, listVisibleTests(dir));
    return { id: '(baseline fixture)', ok: result.passed, steps: [step('visible suite passes on the untouched fixture', result.passed, summarize(result))] };
  } catch (error) {
    return { id: '(baseline fixture)', ok: false, steps: [step('verification ran', false, errorMessage(error))] };
  } finally {
    removeTree(tempRoot);
  }
}
