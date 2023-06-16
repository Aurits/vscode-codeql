import { Discovery } from "../discovery";
import {
  EventEmitter,
  RelativePattern,
  Uri,
  WorkspaceFoldersChangeEvent,
  workspace,
} from "vscode";
import { MultiFileSystemWatcher } from "./multi-file-system-watcher";
import { AppEventEmitter } from "../events";
import { extLogger } from "..";
import { lstat, pathExists } from "fs-extra";
import { containsPath } from "../../pure/files";
import { getOnDiskWorkspaceFoldersObjects } from "./workspace-folders";

interface PathData {
  path: string;
}

/**
 * Discovers all files matching a given filter contained in the workspace.
 *
 * Scans the whole workspace on startup, and then watches for changes to files
 * to do the minimum work to keep up with changes.
 *
 * Can configure which changes it watches for, which files are considered
 * relevant, and what extra data to compute for each file.
 */
export abstract class FilePathDiscovery<T extends PathData> extends Discovery {
  /** The set of known paths we are tracking */
  protected paths: T[] = [];

  /** Event that fires whenever the set of known paths changes */
  protected readonly onDidChangePathsEmitter: AppEventEmitter<void>;

  /**
   * The set of file paths that may have changed on disk since the last time
   * refresh was run. Whenever a watcher reports some change to a file we add
   * it to this set, and then during the next refresh we will process all
   * file paths from this set and update our internal state to match whatever
   * we find on disk (i.e. the file exists, doesn't exist, computed data has
   * changed).
   */
  private readonly changedFilePaths = new Set<string>();

  /**
   * Watches for changes to files and directories in all workspace folders.
   */
  private readonly watcher: MultiFileSystemWatcher = this.push(
    new MultiFileSystemWatcher(),
  );

  /**
   * @param name Name of the discovery operation, for logging purposes.
   * @param fileWatchPattern Passed to `vscode.RelativePattern` to determine the files to watch for changes to.
   */
  constructor(name: string, private readonly fileWatchPattern: string) {
    super(name, extLogger);

    this.onDidChangePathsEmitter = this.push(new EventEmitter<void>());
    this.push(
      workspace.onDidChangeWorkspaceFolders(
        this.workspaceFoldersChanged.bind(this),
      ),
    );
    this.push(this.watcher.onDidChange(this.fileChanged.bind(this)));
  }

  /**
   * Compute any extra data to be stored regarding the given path.
   */
  protected abstract getDataForPath(path: string): Promise<T>;

  /**
   * Is the given path relevant to this discovery operation?
   */
  protected abstract pathIsRelevant(path: string): boolean;

  /**
   * Should the given new data overwrite the existing data we have stored?
   */
  protected abstract shouldOverwriteExistingData(
    newData: T,
    existingData: T,
  ): boolean;

  /**
   * Do the initial scan of the entire workspace and set up watchers for future changes.
   */
  public async initialRefresh() {
    getOnDiskWorkspaceFoldersObjects().forEach((workspaceFolder) => {
      this.changedFilePaths.add(workspaceFolder.uri.fsPath);
    });

    this.updateWatchers();
    return this.refresh();
  }

  private workspaceFoldersChanged(event: WorkspaceFoldersChangeEvent) {
    event.added.forEach((workspaceFolder) => {
      this.changedFilePaths.add(workspaceFolder.uri.fsPath);
    });
    event.removed.forEach((workspaceFolder) => {
      this.changedFilePaths.add(workspaceFolder.uri.fsPath);
    });

    this.updateWatchers();
    void this.refresh();
  }

  private updateWatchers() {
    this.watcher.clear();
    for (const workspaceFolder of getOnDiskWorkspaceFoldersObjects()) {
      // Watch for changes to individual files
      this.watcher.addWatch(
        new RelativePattern(workspaceFolder, this.fileWatchPattern),
      );
      // need to explicitly watch for changes to directories themselves.
      this.watcher.addWatch(new RelativePattern(workspaceFolder, "**/"));
    }
  }

  private fileChanged(uri: Uri) {
    this.changedFilePaths.add(uri.fsPath);
    void this.refresh();
  }

  protected async discover() {
    let pathsUpdated = false;
    for (const path of this.changedFilePaths) {
      this.changedFilePaths.delete(path);
      if (await this.handledChangedPath(path)) {
        pathsUpdated = true;
      }
    }

    if (pathsUpdated) {
      this.onDidChangePathsEmitter.fire();
    }
  }

  private async handledChangedPath(path: string): Promise<boolean> {
    if (!(await pathExists(path)) || !this.pathIsInWorkspace(path)) {
      return this.handleRemovedPath(path);
    }
    if ((await lstat(path)).isDirectory()) {
      return await this.handleChangedDirectory(path);
    }
    return this.handleChangedFile(path);
  }

  private pathIsInWorkspace(path: string): boolean {
    return getOnDiskWorkspaceFoldersObjects().some((workspaceFolder) =>
      containsPath(workspaceFolder.uri.fsPath, path),
    );
  }

  private handleRemovedPath(path: string): boolean {
    const oldLength = this.paths.length;
    this.paths = this.paths.filter((q) => !containsPath(path, q.path));
    return this.paths.length !== oldLength;
  }

  private async handleChangedDirectory(path: string): Promise<boolean> {
    const newPaths = await workspace.findFiles(
      new RelativePattern(path, this.fileWatchPattern),
    );

    let pathsUpdated = false;
    for (const path of newPaths) {
      if (await this.addOrUpdatePath(path.fsPath)) {
        pathsUpdated = true;
      }
    }
    return pathsUpdated;
  }

  private async handleChangedFile(path: string): Promise<boolean> {
    if (this.pathIsRelevant(path)) {
      return await this.addOrUpdatePath(path);
    } else {
      return false;
    }
  }

  private async addOrUpdatePath(path: string): Promise<boolean> {
    const data = await this.getDataForPath(path);
    const existingDataIndex = this.paths.findIndex((x) => x.path === path);
    if (existingDataIndex !== -1) {
      if (
        this.shouldOverwriteExistingData(data, this.paths[existingDataIndex])
      ) {
        this.paths.splice(existingDataIndex, 1, data);
        return true;
      } else {
        return false;
      }
    } else {
      this.paths.push(data);
      return true;
    }
  }
}
