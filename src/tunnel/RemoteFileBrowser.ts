import { FileTransferClient } from "./FileTransferClient";
import { RemoteFileEntry } from "./FileTransferTypes";

export class RemoteFileBrowser {
  constructor(private readonly client: FileTransferClient) {}

  listProjectPath(remotePath: string): Promise<RemoteFileEntry[]> {
    return this.client.list(remotePath).then((result) => result.entries);
  }

  statProjectPath(remotePath: string): Promise<RemoteFileEntry> {
    return this.client.stat(remotePath);
  }
}
