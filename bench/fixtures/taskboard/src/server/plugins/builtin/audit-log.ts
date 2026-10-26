import type { Plugin } from '../loader.ts';

/** Writes one structured log line for every task event. */
const auditLog: Plugin = {
  name: 'audit-log',
  setup({ events, logger }) {
    return events.subscribe((event) => {
      logger.info('audit', { type: event.type, actorId: event.actorId, taskId: event.task.id });
    });
  },
};

export default auditLog;
