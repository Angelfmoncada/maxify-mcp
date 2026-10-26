import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_TITLE_LENGTH } from '../src/shared/constants.ts';
import {
  ValidationError,
  validateLoginInput,
  validateRegisterInput,
  validateStatus,
  validateTaskInput,
  validateTaskPatch,
} from '../src/shared/validation.ts';

function issuesOf(action: () => unknown): Array<{ field: string; message: string }> {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof ValidationError) return error.issues;
    throw error;
  }
  return [];
}

describe('validateTaskInput', () => {
  it('accepts a minimal task and trims the title', () => {
    assert.deepEqual(validateTaskInput({ title: '  Ship it  ' }), { title: 'Ship it' });
  });

  it('keeps the optional fields that were provided', () => {
    const input = validateTaskInput({ title: 'Plan', description: 'Q3', priority: 'high', dueDate: '2025-09-30' });
    assert.deepEqual(input, { title: 'Plan', description: 'Q3', priority: 'high', dueDate: '2025-09-30' });
  });

  it('accepts a null due date', () => {
    assert.equal(validateTaskInput({ title: 'Plan', dueDate: null }).dueDate, null);
  });

  it('requires a non-empty title', () => {
    assert.deepEqual(issuesOf(() => validateTaskInput({ title: '   ' })), [{ field: 'title', message: 'is required' }]);
  });

  it('rejects a title above the maximum length', () => {
    const issues = issuesOf(() => validateTaskInput({ title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }));
    assert.equal(issues[0]?.field, 'title');
  });

  it('rejects an unknown priority and a malformed date, reporting both', () => {
    const issues = issuesOf(() => validateTaskInput({ title: 'Plan', priority: 'asap', dueDate: '30/09/2025' }));
    assert.deepEqual(issues.map((issue) => issue.field).sort(), ['dueDate', 'priority']);
  });

  it('rejects an impossible calendar date', () => {
    assert.equal(issuesOf(() => validateTaskInput({ title: 'Plan', dueDate: '2025-13-45' })).length, 1);
  });

  it('rejects bodies that are not objects', () => {
    assert.deepEqual(issuesOf(() => validateTaskInput('title')), [{ field: 'body', message: 'must be a JSON object' }]);
    assert.equal(issuesOf(() => validateTaskInput(null)).length, 1);
  });
});

describe('validateTaskPatch', () => {
  it('accepts a single changed field', () => {
    assert.deepEqual(validateTaskPatch({ priority: 'urgent' }), { priority: 'urgent' });
  });

  it('allows clearing the due date', () => {
    assert.deepEqual(validateTaskPatch({ dueDate: null }), { dueDate: null });
  });

  it('refuses an empty patch', () => {
    assert.equal(issuesOf(() => validateTaskPatch({}))[0]?.field, 'body');
  });

  it('validates the title only when it is present', () => {
    assert.equal(issuesOf(() => validateTaskPatch({ title: '' }))[0]?.field, 'title');
  });
});

describe('validateStatus', () => {
  it('accepts a status or an object holding one', () => {
    assert.equal(validateStatus('done'), 'done');
    assert.equal(validateStatus({ status: 'in_review' }), 'in_review');
  });

  it('rejects unknown statuses', () => {
    assert.equal(issuesOf(() => validateStatus({ status: 'blocked' }))[0]?.field, 'status');
  });
});

describe('account input', () => {
  it('normalizes the email address on login', () => {
    assert.deepEqual(validateLoginInput({ email: ' Ada@Example.COM ', password: 'longenough1' }), {
      email: 'ada@example.com',
      password: 'longenough1',
    });
  });

  it('requires a long enough password', () => {
    assert.equal(issuesOf(() => validateLoginInput({ email: 'ada@example.com', password: 'short' }))[0]?.field, 'password');
  });

  it('requires a name to register', () => {
    const issues = issuesOf(() => validateRegisterInput({ email: 'ada@example.com', password: 'longenough1' }));
    assert.deepEqual(issues, [{ field: 'name', message: 'is required' }]);
  });
});

describe('ValidationError', () => {
  it('summarizes every issue in its message and maps to HTTP 400', () => {
    const error = new ValidationError([
      { field: 'title', message: 'is required' },
      { field: 'priority', message: 'must be one of low, medium, high, urgent' },
    ]);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.match(error.message, /title: is required; priority:/);
  });
});
