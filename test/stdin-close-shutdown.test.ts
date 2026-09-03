import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'build', 'index.js');

// Regression test for an orphan-process bug: an MCP client that dies without
// signaling this child (crash, force-quit, a closed terminal window) used to
// leave it running forever. StdioServerTransport only wires 'data'/'error' on
// process.stdin, never 'end', so nothing reacted to the pipe closing unless
// the process also received SIGTERM/SIGINT. This spawns the real built binary
// and closes its stdin exactly like a dead client would, since the bug is
// about real OS pipe EOF propagation — mocking process.stdin would not
// exercise the thing that was actually broken.
describe('stdio client-disconnect shutdown', () => {
  it('exits once stdin reaches EOF instead of surviving as an orphan', async () => {
    // test/setup.js sets GODOT_MCP_UNRESTRICTED=true globally so other tests can
    // use tmpdir paths — but that flag is on startMcpServer's dangerousBypassFlags
    // list, so inheriting it here makes the child [FATAL]-exit before it even
    // reaches the stdin wiring this test means to exercise. Strip it back off.
    const childEnv = { ...process.env, GODOT_MCP_NO_DASHBOARD: '1' };
    delete childEnv.GODOT_MCP_UNRESTRICTED;

    const child = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    // Let startup (feature-flag logging, dashboard-skip check, update check) settle.
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(child.exitCode, 'server should still be running before stdin closes').toBeNull();

    const exited = new Promise<number | null>(resolve => {
      child.once('exit', code => resolve(code));
    });

    // Simulates the MCP client dying without signaling this child: close our
    // write end of the pipe, so the child's stdin sees EOF.
    child.stdin.end();

    const result = await Promise.race([
      exited.then(code => ({ timedOut: false as const, code })),
      new Promise<{ timedOut: true }>(resolve => setTimeout(() => resolve({ timedOut: true }), 5000)),
    ]);

    if (result.timedOut) {
      child.kill('SIGKILL');
      throw new Error('Server did not exit within 5s of stdin closing — it is orphaned instead of shutting down.');
    }
    expect(result.code).toBe(0);
  }, 15000);
});
