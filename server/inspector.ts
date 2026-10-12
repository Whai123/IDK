import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { DepartmentId, Evidence, Priority } from '../src/lib/types.ts';
import { runCommand } from './providers.ts';

export interface InspectionFinding {
  key: string;
  title: string;
  description: string;
  departmentId: DepartmentId;
  priority: Priority;
  requiresDirection?: boolean;
  evidence: Pick<Evidence, 'label' | 'detail' | 'kind'>[];
  artifact?: string;
}

export interface InspectionResult {
  repoPath: string;
  summary: string;
  findings: InspectionFinding[];
}

async function safePath(root: string, name: string): Promise<string | null> {
  try {
    const target = await realpath(join(root, name));
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error(`Audit refused ${name}: its symlink points outside the repository.`);
    return target;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function boundedRead(root: string, name: string, maxBytes = 65_536): Promise<string | null> {
  const path = await safePath(root, name);
  if (!path) return null;
  const info = await stat(path);
  if (!info.isFile()) return null;
  if (info.size > maxBytes) throw new Error(`Audit refused ${name}: the file exceeds the ${maxBytes} byte inspection limit.`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`Audit refused ${name}: the file exceeds the ${maxBytes} byte inspection limit.`);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

function fileEvidence(label: string, detail: string): Pick<Evidence, 'label' | 'detail' | 'kind'> {
  return { label, detail, kind: 'file' };
}

/** An evidence-only audit. It reads a fixed set of project metadata and never runs repository scripts. */
export async function inspectRepository(repoPath: string): Promise<InspectionResult> {
  const root = await realpath(repoPath);
  if (!(await stat(root)).isDirectory()) throw new Error('Repository path must be a directory.');
  const git = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: 5000, outputLimitBytes: 8192 });
  if (git.exitCode !== 0) throw new Error('This directory is not a Git repository. Initialize or clone a repository first.');
  const canonicalGitRoot = await realpath(git.stdout.trim());
  if (canonicalGitRoot !== root) throw new Error('Connect the repository root, rather than a subdirectory.');
  const status = await runCommand('git', ['-c', 'core.fsmonitor=false', 'status', '--short', '--untracked-files=normal'], { cwd: root, timeoutMs: 5000, outputLimitBytes: 65_536 });
  if (status.exitCode !== 0 || status.truncated || status.timedOut) throw new Error('Could not obtain a bounded Git status for this repository.');
  const findings: InspectionFinding[] = [];
  let readme: string | null = null;
  let readmeName = 'README.md';
  for (const name of ['README.md', 'readme.md', 'README', 'README.rst']) {
    const content = await boundedRead(root, name, 65_536);
    if (content !== null) { readme = content; readmeName = name; break; }
  }
  const manifestNames: string[] = [];
  let packageData: { scripts?: Record<string, unknown> } | null = null;
  for (const name of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
    const content = await boundedRead(root, name);
    if (content === null) continue;
    manifestNames.push(name);
    if (name === 'package.json') {
      try { packageData = JSON.parse(content) as { scripts?: Record<string, unknown> }; }
      catch {
        findings.push({ key: 'engineering:invalid-package-json', title: 'Repair the package manifest', description: 'package.json could not be parsed as JSON. Fixing its syntax is a concrete prerequisite for Node package tooling.', departmentId: 'engineering', priority: 'high', evidence: [fileEvidence('Invalid manifest', 'A bounded read of package.json failed JSON parsing. No repository scripts were executed.')] });
      }
    }
  }
  const testLocations: string[] = [];
  for (const name of ['tests', 'test', '__tests__', 'src/__tests__', 'spec']) {
    const path = await safePath(root, name);
    if (path && (await stat(path)).isDirectory()) testLocations.push(name);
  }
  const scriptNames = packageData?.scripts && typeof packageData.scripts === 'object' ? Object.keys(packageData.scripts).slice(0, 50) : [];
  if (readme === null || readme.trim().length < 80) {
    findings.push({ key: 'product:define-first-outcome', title: 'Define the first user outcome', description: 'The inspected README does not provide enough context to establish the intended user and outcome. Ask the founder for the product direction before choosing features. This is an evidence-backed planning proposal, not customer research.', departmentId: 'product', priority: 'high', requiresDirection: true, evidence: [fileEvidence('Product context', readme === null ? 'No README was found among the supported top-level README names.' : `${readmeName} contains fewer than 80 characters after trimming leading and trailing whitespace.`)] });
  }
  if (readme === null || !/install|setup|getting started|quick.?start|usage|เริ่มต้น|ติดตั้ง/i.test(readme)) {
    findings.push({ key: 'support:document-quickstart', title: 'Document a reproducible quickstart', description: 'The bounded README audit found no recognizable setup or usage section. Propose a short quickstart grounded in the actual project commands, then verify it in an isolated task. Existing instructions may live elsewhere; this audit did not search the entire repository.', departmentId: 'support', priority: 'medium', evidence: [fileEvidence('README quickstart check', readme === null ? 'No supported README exists at the repository root.' : `${readmeName} has no matching setup, install, quickstart or usage marker.`), fileEvidence('Known project metadata', manifestNames.length ? `Top-level manifests observed: ${manifestNames.join(', ')}. Package script names: ${scriptNames.join(', ') || '(none)'}.` : 'No supported top-level manifest found; confirm the stack before writing setup commands.')] });
  }
  if (!manifestNames.length) {
    findings.push({ key: 'engineering:confirm-project-stack', title: 'Confirm the stack and a runnable entry point', description: 'No supported top-level project manifest was found. The repository could be documentation-only, use another stack, or still be uninitialized. Ask for the intended direction before creating application scaffolding.', departmentId: 'engineering', priority: 'high', requiresDirection: true, evidence: [fileEvidence('Manifest inspection', 'Checked package.json, pyproject.toml, Cargo.toml and go.mod at the repository root; none were present.')] });
  } else if (!testLocations.length && !scriptNames.some(name => /^test(?::|$)/.test(name))) {
    findings.push({ key: 'engineering:locate-verification', title: 'Identify how to verify the first change', description: 'No common top-level test directory or Node test script was found. Tests may be inline or elsewhere. Locate the project’s existing verification method and propose one useful check before adding tests.', departmentId: 'engineering', priority: 'medium', evidence: [fileEvidence('Verification entry points', `Checked tests/, test/, __tests__/, src/__tests__/ and spec/. Node script names: ${scriptNames.join(', ') || '(none)'}. This is not a recursive test search.`)] });
  }
  if (packageData && !scriptNames.some(name => ['dev', 'start', 'build'].includes(name))) {
    findings.push({ key: 'engineering:document-entry-command', title: 'Clarify the project entry command', description: 'The Node manifest has no conventional dev, start or build script. It may be a library or use another command. Document the intended entry point rather than inventing an application workflow.', departmentId: 'engineering', priority: 'medium', evidence: [fileEvidence('Node script inventory', `package.json script names: ${scriptNames.join(', ') || '(none)'}.`)] });
  }
  if (readme === null || !/demo|screenshot|preview|example|ตัวอย่าง/i.test(readme)) {
    findings.push({ key: 'marketing:draft-project-preview', title: 'Propose a concrete project preview', description: 'The README audit found no recognizable demo, screenshot or example marker. Hypothesis: a preview could help potential users understand the project. Draft an example from real capabilities once product direction is known; do not invent traction, publish, or contact anyone.', departmentId: 'marketing', priority: 'low', requiresDirection: readme === null || readme.trim().length < 80, evidence: [fileEvidence('Public project preview check', readme === null ? 'No supported README was found at the repository root.' : `${readmeName} has no matching demo, screenshot, preview or example marker. Other repository pages were not inspected.`)] });
  }
  return { repoPath: root, summary: `Inspected Git status, ${readme ? readmeName : 'README presence'}, ${manifestNames.length ? manifestNames.join(', ') : 'supported manifest presence'}, and ${testLocations.length ? testLocations.join(', ') : 'common test directory presence'}. ${status.stdout ? 'The checkout has uncommitted changes.' : 'The checkout is clean.'} No project scripts or model runs were executed. ${findings.length} proposals found.`, findings };
}
