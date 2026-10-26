import type { ServerConfig } from '../config.ts';
import type { TaskEventBus } from '../tasks/events.ts';
import type { Logger } from '../util/logger.ts';

export interface PluginContext {
  events: TaskEventBus;
  logger: Logger;
  config: ServerConfig;
}

export interface Plugin {
  name: string;
  /** Wires the plugin into the app. May return a function that undoes the wiring. */
  setup(context: PluginContext): void | (() => void);
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

/** Loads the built-in plugin called `name` from ./builtin/<name>.ts. */
export async function loadPlugin(name: string): Promise<Plugin> {
  if (!PLUGIN_NAME.test(name)) throw new Error(`Invalid plugin name "${name}"`);
  const module = (await import(`./builtin/${name}.ts`)) as { default?: Plugin };
  const plugin = module.default;
  if (plugin === undefined || typeof plugin.setup !== 'function') {
    throw new Error(`Plugin "${name}" must default-export an object with a setup() function`);
  }
  return plugin;
}

/** Loads and sets up each named plugin in order. Returns the functions that tear them down again. */
export async function loadPlugins(
  names: readonly string[],
  context: PluginContext,
): Promise<Array<() => void>> {
  const teardowns: Array<() => void> = [];
  for (const name of names) {
    const plugin = await loadPlugin(name);
    const teardown = plugin.setup(context);
    if (typeof teardown === 'function') teardowns.push(teardown);
    context.logger.info('plugin loaded', { plugin: plugin.name });
  }
  return teardowns;
}
