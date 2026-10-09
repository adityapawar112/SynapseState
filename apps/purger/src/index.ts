import { Project } from "ts-morph";

export function createPurgerProject(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
  });
}
