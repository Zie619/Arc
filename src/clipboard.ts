import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Pull an image off the system clipboard and save it to a file.
 *
 * A terminal pastes TEXT on its own; an image on the clipboard never arrives
 * as keystrokes, so ctrl+v asks the OS directly. macOS only — osascript can
 * write the clipboard's PNG representation straight to disk with no extra
 * dependency. Returns the saved path, or null when there is no image (or on
 * any other platform).
 */
export function saveClipboardImage(dir = join(tmpdir(), 'arc-images')): string | null {
  if (process.platform !== 'darwin') return null
  try {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `paste-${Date.now()}.png`)
    execFileSync('osascript', [
      '-e', `set f to open for access POSIX file ${JSON.stringify(path)} with write permission`,
      '-e', 'try',
      '-e', 'write (the clipboard as «class PNGf») to f',
      '-e', 'end try',
      '-e', 'close access f',
    ], { stdio: 'ignore', timeout: 8_000 })
    if (statSync(path).size > 8) return path
    rmSync(path, { force: true })
    return null
  } catch {
    return null
  }
}
