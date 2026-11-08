// Faux systeme pour les tests des outils "hub" : simule virsh, qemu-img, xorriso, virt-builder et curl.
// AUCUNE commande reelle n'est lancee : tout passe par la couture `setRunner` de dist/utils/runner.js.
// Toute commande hors de cette liste, ou virsh sans `-c qemu:///system`, fait echouer le test.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const { setRunner } = await import('../../dist/utils/runner.js');

const ALLOWED = new Set(['virsh', 'qemu-img', 'xorriso', 'virt-builder', 'curl']);
const GIB = 1024 ** 3;

const res = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });
const flag = (args, name) => args[args.indexOf(name) + 1];

/**
 * @param {object} [init]
 * @param {Record<string,string>} [init.domains]  nom -> etat (running, paused, shut off...)
 * @param {string[]} [init.networks]
 * @param {string[]} [init.volumes]               volumes deja presents dans le pool
 * @param {Record<string,object>} [init.images]   chemin -> sortie JSON de `qemu-img info`
 * @param {Record<string,string>} [init.xml]      nom de VM -> XML rendu par dumpxml
 * @param {Record<string,{code?:number,stderr?:string}>} [init.fail]  sous-commande -> echec force
 */
export function installFakeSystem(init = {}) {
  const state = {
    domains: { ...(init.domains ?? {}) },
    networks: [...(init.networks ?? ['default'])],
    volumes: new Set(init.volumes ?? []),
    images: { ...(init.images ?? {}) },
    xml: { ...(init.xml ?? {}) },
    snapshotCurrent: init.snapshotCurrent ?? null,
    defined: [],
    seeds: [],
    uploads: [],
    calls: [],
    violations: []
  };
  const failures = init.fail ?? {};

  function virsh(args) {
    if (args[0] !== '-c' || args[1] !== 'qemu:///system') state.violations.push(`virsh sans -c qemu:///system: ${args.join(' ')}`);
    const [sub, ...rest] = args.slice(2);
    if (failures[sub]) return res(failures[sub].code ?? 1, '', failures[sub].stderr ?? `${sub} failed`);
    const vm = rest[0];
    switch (sub) {
      case 'domstate':
        return vm in state.domains ? res(0, `${state.domains[vm]}\n`) : res(1, '', `error: failed to get domain '${vm}'`);
      case 'suspend': state.domains[vm] = 'paused'; return res(0, `Domain '${vm}' suspended\n`);
      case 'resume': state.domains[vm] = 'running'; return res(0, `Domain '${vm}' resumed\n`);
      case 'reboot': return res(0, `Domain '${vm}' is being rebooted\n`);
      case 'reset': return res(0, `Domain '${vm}' was reset\n`);
      case 'shutdown': state.domains[vm] = init.shutdownStays ? 'running' : 'shut off'; return res(0, `Domain '${vm}' is being shutdown\n`);
      case 'start': state.domains[vm] = 'running'; return res(0, `Domain '${vm}' started\n`);
      case 'list': return res(0, `${Object.keys(state.domains).join('\n')}\n`);
      case 'net-list': return res(0, `${state.networks.join('\n')}\n`);
      case 'vol-list': return res(0, ` Name   Path\n------------\n${[...state.volumes].map((v) => ` ${v}   /pool/${v}`).join('\n')}\n`);
      case 'vol-create-as': state.volumes.add(rest[1]); return res(0);
      case 'vol-upload': {
        const [, , name, file] = rest;
        if (!existsSync(file)) return res(1, '', `error: cannot read ${file}`);
        state.uploads.push({ name, file });
        return res(0);
      }
      case 'pool-refresh': return res(0);
      case 'vol-resize': return res(0);
      case 'vol-path': return res(0, `/var/lib/libvirt/images/${rest[2]}\n`);
      case 'vol-delete': state.volumes.delete(rest[2]); return res(0);
      case 'define': {
        const xml = readFileSync(rest[0], 'utf8');
        const name = /<name>([^<]+)<\/name>/.exec(xml)?.[1];
        state.defined.push({ name, xml });
        state.domains[name] = 'shut off';
        return res(0, `Domain '${name}' defined\n`);
      }
      case 'undefine': delete state.domains[vm]; return res(0);
      case 'dumpxml': return vm in state.xml ? res(0, state.xml[vm]) : res(1, '', `error: failed to get domain '${vm}'`);
      case 'snapshot-current':
        return state.snapshotCurrent ? res(0, `${state.snapshotCurrent}\n`) : res(1, '', 'error: domain has no current snapshot');
      default: return res(1, '', `fake virsh: sous-commande inattendue ${sub}`);
    }
  }

  function other(cmd, args) {
    if (cmd === 'qemu-img') {
      const path = args[args.length - 1];
      return path in state.images ? res(0, JSON.stringify(state.images[path])) : res(1, '', `qemu-img: Could not open '${path}'`);
    }
    if (cmd === 'xorriso') {
      const out = flag(args, '-o');
      // contenu de la graine capture avant que l'outil ne supprime son dossier de travail
      const read = (suffix) => {
        const file = args.find((a) => a.endsWith(suffix));
        return file ? readFileSync(file, 'utf8') : null;
      };
      state.seeds.push({ userData: read('user-data'), metaData: read('meta-data'), label: args[args.indexOf('-V') + 1] });
      writeFileSync(out, Buffer.alloc(4096));
      return res(0);
    }
    if (cmd === 'virt-builder') {
      if (failures['virt-builder']) return res(1, '', 'virt-builder failed');
      const out = flag(args, '--output');
      const size = Number.parseInt(flag(args, '--size'), 10) * GIB;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.alloc(1024));
      state.images[out] = { format: 'qcow2', 'virtual-size': size };
      return res(0);
    }
    if (cmd === 'curl') {
      if (failures.curl) return res(failures.curl.code ?? 22, '', failures.curl.stderr ?? 'curl: (22) The requested URL returned error: 404');
      const out = flag(args, '--output');
      writeFileSync(out, Buffer.alloc(2048));
      state.images[out] = init.downloadInfo ?? { format: 'qcow2', 'virtual-size': 2 * GIB };
      return res(0);
    }
    return res(127, '', `${cmd}: not found`);
  }

  setRunner(async (command, args, options) => {
    state.calls.push({ command, args: [...args], tool: options.tool });
    if (!ALLOWED.has(command)) {
      state.violations.push(`commande non prevue: ${command}`);
      return res(127, '', `${command}: not allowed in tests`);
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) state.violations.push('arguments non-tableau de chaines');
    return command === 'virsh' ? virsh(args) : other(command, args);
  });

  /** Appels virsh dont la sous-commande est `sub` */
  state.virshCalls = (sub) => state.calls.filter((c) => c.command === 'virsh' && c.args[2] === sub);
  /** Sous-commandes virsh qui modifient l'etat */
  state.mutations = () => state.calls
    .filter((c) => c.command === 'virsh' && ['suspend', 'resume', 'reboot', 'reset', 'shutdown', 'start', 'vol-create-as', 'vol-upload',
      'vol-resize', 'vol-delete', 'define', 'undefine'].includes(c.args[2]))
    .map((c) => c.args[2]);
  return state;
}

export function resetRunner() {
  // Garde-fou : un test qui n'installe pas de faux systeme ne doit JAMAIS atteindre le vrai executeur
  setRunner(async (command) => ({ code: 127, stdout: '', stderr: `${command}: aucun faux systeme installe` }));
}

export const parse = (result) => JSON.parse(result.content[0].text);

// Des l import : le vrai executeur est coupe tant qu un test n installe pas son faux systeme
resetRunner();
