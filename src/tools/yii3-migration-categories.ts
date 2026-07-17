/** Aggregated Yii2-to-Yii3 migration catalog and effort tariff. */

import type { CategoryDefinition, EffortBucket } from "./yii3-migration-types.js";
import { APPLICATION_CATEGORIES } from "./yii3-migration-categories-application.js";
import { INFRASTRUCTURE_CATEGORIES } from "./yii3-migration-categories-infrastructure.js";
import { MODEL_VIEW_CATEGORIES } from "./yii3-migration-categories-model-view.js";
import { RUNTIME_CATEGORIES } from "./yii3-migration-categories-runtime.js";

export const EFFORT_HOURS: Record<EffortBucket, [number, number]> = {
  trivial: [0.05, 0.15],
  small: [0.25, 0.75],
  medium: [1, 3],
  large: [4, 12],
};

export const CATEGORIES: CategoryDefinition[] = [
  ...RUNTIME_CATEGORIES,
  ...APPLICATION_CATEGORIES,
  ...MODEL_VIEW_CATEGORIES,
  ...INFRASTRUCTURE_CATEGORIES,
];
