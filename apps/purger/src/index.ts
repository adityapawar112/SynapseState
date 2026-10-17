import { Project } from "ts-morph";

export function createPurgerProject(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
  });
}

// Re-export qualification domain types, engine, and SQL queries
export * from "./qualification/types.js";
export * from "./qualification/engine.js";
export * from "./qualification/queries.js";
