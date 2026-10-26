import type { Plugin } from '../loader.ts';

/** Announces finished tasks. The message is only logged; delivery to Slack is not wired up yet. */
const slackNotify: Plugin = {
  name: 'slack-notify',
  setup({ events, logger }) {
    return events.subscribe((event) => {
      if (event.type === 'task.status_changed' && event.task.status === 'done') {
        logger.info('slack message', { text: `Task finished: ${event.task.title}` });
      }
    });
  },
};

export default slackNotify;
