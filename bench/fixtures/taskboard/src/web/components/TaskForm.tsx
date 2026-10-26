import { useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_TITLE_LENGTH, TASK_PRIORITIES } from '@shared/constants';
import type { TaskInput, TaskPriority } from '@shared/types';
import { ValidationError, validateTaskInput } from '@shared/validation';
import { priorityLabel } from '../utils/format';

export interface TaskFormProps {
  onSubmit: (input: TaskInput) => Promise<void>;
}

type FieldErrors = Partial<Record<string, string>>;

function toFieldErrors(error: ValidationError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) errors[issue.field] = issue.message;
  return errors;
}

/** Creates a task. Runs the same validation as the server before submitting. */
export function TaskForm({ onSubmit }: TaskFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [dueDate, setDueDate] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    let input: TaskInput;
    try {
      input = validateTaskInput({
        title,
        description,
        priority,
        dueDate: dueDate === '' ? null : dueDate,
      });
    } catch (caught: unknown) {
      if (caught instanceof ValidationError) {
        setErrors(toFieldErrors(caught));
        return;
      }
      throw caught;
    }
    setSubmitting(true);
    try {
      await onSubmit(input);
      setTitle('');
      setDescription('');
      setDueDate('');
      setErrors({});
    } catch (caught: unknown) {
      setErrors({ form: caught instanceof Error ? caught.message : 'Could not save the task' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="task-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <label>
        Title
        <input value={title} maxLength={MAX_TITLE_LENGTH} onChange={(event) => setTitle(event.target.value)} />
        {errors.title !== undefined && <span role="alert">{errors.title}</span>}
      </label>
      <label>
        Description
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        {errors.description !== undefined && <span role="alert">{errors.description}</span>}
      </label>
      <label>
        Priority
        <select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
          {TASK_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {priorityLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Due date
        <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        {errors.dueDate !== undefined && <span role="alert">{errors.dueDate}</span>}
      </label>
      {errors.form !== undefined && <p role="alert">{errors.form}</p>}
      <button type="submit" disabled={submitting}>
        Add task
      </button>
    </form>
  );
}
