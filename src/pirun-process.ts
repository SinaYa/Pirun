import { execFileSync } from 'node:child_process';

/** Stop Pi and any command it launched, so a timeout is a real hard boundary. */
export function terminateProcessTree(pid: number) {
	if (!Number.isFinite(pid) || pid <= 0) return;
	if (process.platform === 'win32') {
		try {
			execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
				stdio: 'ignore',
				windowsHide: true
			});
		} catch {
			// The process may have exited between the liveness check and taskkill.
		}
		return;
	}
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Already gone.
		}
	}
}
