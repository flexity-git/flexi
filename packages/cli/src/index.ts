export { main, USAGE } from "./main.js";
export { parseArgs, parseTarget, type ParsedArgs } from "./args.js";
export { discoverModules, type DiscoveredModule, type DiscoverOptions } from "./discovery.js";
export {
  buildTaskContext,
  createShoptetFactory,
  loadShoptetPackage,
  runTask,
  type ShoptetClientOptions,
  type ShoptetPackage,
  type TaskOutcome,
} from "./context.js";
