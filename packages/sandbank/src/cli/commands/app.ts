import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createSandbankAppScaffold } from '../../app-kernel.js'
import type { CliFlags } from '../auth.js'

export async function appCommand(args: string[], flags: CliFlags): Promise<void> {
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    usage()
    return
  }

  const subcommand = args.shift()
  switch (subcommand) {
    case 'scaffold':
      return scaffoldCommand(args, flags)
    default:
      usage()
      process.exit(1)
  }
}

async function scaffoldCommand(args: string[], flags: CliFlags): Promise<void> {
  const outDir = takeOption(args, '--out')
  const name = takeOption(args, '--name')
  const backend = takeOption(args, '--backend') ?? 'db9'
  const packageName = takeOption(args, '--package-name')
  const json = flags.json || takeFlag(args, '--json')
  const id = args.shift()
  if (!id) {
    usage()
    process.exit(1)
  }

  const scaffold = createSandbankAppScaffold({ id, name, backend, packageName })
  if (outDir) {
    for (const [relativePath, contents] of Object.entries(scaffold.files)) {
      const target = join(outDir, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents)
    }
    if (json) {
      console.log(JSON.stringify({
        id: scaffold.id,
        name: scaffold.name,
        outDir,
        files: Object.keys(scaffold.files),
      }, null, 2))
      return
    }
    console.log(`Created ${scaffold.name} app scaffold in ${outDir}`)
    for (const path of Object.keys(scaffold.files)) console.log(`  ${path}`)
    return
  }

  if (json) {
    console.log(JSON.stringify(scaffold, null, 2))
    return
  }

  for (const [path, contents] of Object.entries(scaffold.files)) {
    console.log(`--- ${path} ---`)
    console.log(contents.trimEnd())
  }
}

function takeFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name)
  if (idx === -1) return false
  args.splice(idx, 1)
  return true
}

function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  args.splice(idx, 2)
  return value
}

function usage(): void {
  console.log(`Usage: sandbank app scaffold <id> [--name <name>] [--backend db9|postgres] [--out <dir>] [--json]

Creates a Sandbank App Kernel scaffold with an app manifest, capability
contract, default host projections, and branch-first write capability shape.`)
}
