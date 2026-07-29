import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteText(filePath, content) {
  const targetPath = path.resolve(filePath);
  const directoryPath = path.dirname(targetPath);
  const temporaryPath = path.join(directoryPath, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const mode = await existingMode(targetPath);
  let handle = null;

  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(String(content), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, targetPath);
    await syncDirectory(directoryPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function existingMode(filePath) {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if (error?.code === "ENOENT") return 0o666;
    throw error;
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch {
    // The file was already atomically replaced. Some platforms do not allow
    // directory handles to be synchronized.
  } finally {
    await handle?.close().catch(() => {});
  }
}
