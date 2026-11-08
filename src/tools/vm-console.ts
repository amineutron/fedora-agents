/**
 * Outils MCP : adresse de la console graphique et journal du port serie.
 *
 * Lecture seule : rien n'est ouvert ni modifie. L'adresse rendue est celle que libvirt a deja
 * attribuee (socket Unix ou port TCP sur 127.0.0.1) ; un pont reseau (websocket) reste a la charge
 * de l'appelant.
 */

import { open, realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { ErrorCode } from '../config.js';
import {
  vmConsoleSchema,
  vmConsoleLogSchema,
  type VmConsoleParams,
  type VmConsoleLogParams
} from '../utils/vm-hub-schemas.js';
import { imagesDir } from '../utils/vm-images.js';
import { isLoopback, parseGraphics, parseSerialLogs } from '../utils/vm-domain-xml.js';
import { fail, getDomainState, ok, virsh } from '../utils/virsh.js';
import type { ToolDefinition, ToolResult } from './vm-controller.js';

// ========================================
// vm_console
// ========================================
async function vmConsoleHandler(params: unknown): Promise<ToolResult> {
  const { vm_name: vm, type } = vmConsoleSchema.parse(params) as VmConsoleParams;

  const lookup = await getDomainState('vm_console', vm);
  if (!lookup.ok) return fail(lookup.code, lookup.message);
  if (lookup.state !== 'running' && lookup.state !== 'paused') {
    return fail(ErrorCode.VALIDATION_ERROR, `VM '${vm}' n'est pas allumee (etat: ${lookup.state}) : la console graphique n'existe que VM allumee`, { state: lookup.state });
  }

  const dump = await virsh('vm_console', ['dumpxml', vm]);
  if (dump.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, dump.stderr || `virsh dumpxml a echoue (code ${dump.code})`);

  const all = parseGraphics(dump.stdout);
  const wanted = type === 'auto' ? all : all.filter((g) => g.type === type);
  const g = wanted[0];
  if (!g) {
    const declared = all.map((x) => x.type).join(', ') || 'aucun';
    return fail(ErrorCode.VALIDATION_ERROR, `Aucun affichage ${type === 'auto' ? 'graphique' : type} sur la VM '${vm}' (declares: ${declared})`);
  }

  if (g.socket) {
    return ok({
      vm, state: lookup.state, type: g.type, transport: 'unix', socket: g.socket,
      uri: `${g.type}+unix://${g.socket}`, public: false
    });
  }
  if (g.port === null) {
    return fail(ErrorCode.SCRIPT_ERROR, `Port graphique ${g.type} non attribue pour '${vm}'`);
  }
  const address = g.address ?? '127.0.0.1';
  const exposed = !isLoopback(address);
  return ok({
    vm, state: lookup.state, type: g.type, transport: 'tcp', host: address, port: g.port,
    uri: `${g.type}://${address}:${g.port}`, public: exposed,
    ...(exposed ? { warning: `le serveur graphique ecoute sur ${address} (interface non locale) : restreindre l'ecoute a 127.0.0.1` } : {})
  });
}

export const vmConsole: ToolDefinition = {
  name: 'vm_console',
  description: 'Rend l\'adresse de la console graphique d\'une VM allumee (socket Unix ou 127.0.0.1:port, spice ou vnc). N\'ouvre aucun port : adresse deja attribuee par libvirt.',
  inputSchema: vmConsoleSchema,
  handler: vmConsoleHandler
};

// ========================================
// vm_console_log
// ========================================
const MAX_TAIL_BYTES = 512 * 1024;

/** Dossiers ou un journal serie peut etre lu (+ `VM_CONSOLE_LOG_DIRS`, separes par `:`). */
export function serialLogRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.VM_CONSOLE_LOG_DIRS ?? '').split(':').map((d) => d.trim()).filter((d) => d.startsWith('/'));
  return ['/var/log/libvirt', '/var/lib/libvirt', imagesDir(env), ...extra];
}

/**
 * `absent` : le fichier n'existe pas (VM definie sans journal, ou jamais demarree) ;
 * `droits` : il existe peut-etre mais cet utilisateur ne peut ni le parcourir ni le lire ;
 * `hors_racines` : chemin relatif, `..`, ou cible hors des dossiers autorises.
 */
export type LogIssue = 'absent' | 'droits' | 'hors_racines';
type Confined = { real: string } | { issue: LogIssue };

const errnoOf = (error: unknown): string => (error as { code?: string } | null)?.code ?? '';
const issueOf = (error: unknown): LogIssue => (/^(EACCES|EPERM)$/.test(errnoOf(error)) ? 'droits' : 'absent');

/** Chemin reel du journal s'il est un fichier ordinaire sous une racine autorisee. */
async function confinedLog(path: string, roots: readonly string[]): Promise<Confined> {
  if (!path.startsWith('/') || path.includes('..')) return { issue: 'hors_racines' };
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return { issue: issueOf(error) };
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    if (real.startsWith(realRoot + sep)) return { real };
  }
  return { issue: 'hors_racines' };
}

const ISSUE_TEXT: Record<LogIssue, string> = {
  absent: 'le fichier n\'existe pas : VM definie sans journal serie (<log file>), ou jamais demarree depuis sa definition',
  droits: 'droits insuffisants pour cet utilisateur : /var/log/libvirt est reserve a root par defaut, l\'administrateur doit autoriser la lecture (setfacl, voir README)',
  hors_racines: 'chemin hors des dossiers autorises'
};

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** Retire les caracteres de controle, sauf retour a la ligne et tabulation. */
function stripControl(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10 || code === 9 || (code >= 32 && code !== 127)) out += ch;
  }
  return out;
}

/** Derniere `lines` lignes du texte, sans sequences ANSI ni caracteres de controle. */
export function tailLines(text: string, lines: number): string[] {
  const clean = stripControl(text.replace(ANSI_SEQUENCE, '').replace(/\r\n?/g, '\n'));
  const all = clean.split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  return all.slice(-lines);
}

async function readTail(path: string): Promise<{ text: string; truncated: boolean }> {
  const size = (await stat(path)).size;
  const length = Math.min(size, MAX_TAIL_BYTES);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), truncated: size > length };
  } finally {
    await handle.close();
  }
}

async function vmConsoleLogHandler(params: unknown): Promise<ToolResult> {
  const { vm_name: vm, lines } = vmConsoleLogSchema.parse(params) as VmConsoleLogParams;

  const lookup = await getDomainState('vm_console_log', vm);
  if (!lookup.ok) return fail(lookup.code, lookup.message);

  const dump = await virsh('vm_console_log', ['dumpxml', vm]);
  if (dump.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, dump.stderr || `virsh dumpxml a echoue (code ${dump.code})`);

  const declared = parseSerialLogs(dump.stdout);
  if (declared.length === 0) {
    return fail(ErrorCode.VALIDATION_ERROR, `Aucun journal du port serie n'est declare pour '${vm}' (port serie de type pty : pas de trace lisible sans connexion interactive)`);
  }

  const roots = serialLogRoots();
  let last: { path: string; issue: LogIssue } | null = null;
  for (const candidate of declared) {
    const confined = await confinedLog(candidate.path, roots);
    if ('issue' in confined) {
      last = { path: candidate.path, issue: confined.issue };
      continue;
    }
    try {
      const { text, truncated } = await readTail(confined.real);
      const out = tailLines(text, lines);
      return ok({ vm, state: lookup.state, source: candidate.path, kind: candidate.kind, lines: out, count: out.length, truncated });
    } catch (error) {
      if (!/^(EACCES|EPERM|ENOENT)$/.test(errnoOf(error))) throw error;
      last = { path: candidate.path, issue: issueOf(error) };
    }
  }
  const issue = last?.issue ?? 'absent';
  return fail(
    issue === 'absent' ? ErrorCode.VALIDATION_ERROR : ErrorCode.PERMISSION_DENIED,
    `Journal serie de '${vm}' illisible (${last?.path}) : ${ISSUE_TEXT[issue]}`,
    { path: last?.path ?? null, reason: issue, allowed_roots: roots }
  );
}

export const vmConsoleLog: ToolDefinition = {
  name: 'vm_console_log',
  description: 'Rend les dernieres lignes du journal du port serie d\'une VM (fichier declare dans son XML : <log file> ou serie de type fichier). Lecture seule, bornee a 512 Ko, limitee aux dossiers libvirt et au dossier d\'images.',
  inputSchema: vmConsoleLogSchema,
  handler: vmConsoleLogHandler
};

export const vmConsoleTools: ToolDefinition[] = [vmConsole, vmConsoleLog];
