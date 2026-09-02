// @amp-agent-mode {"key":"custom-agent","label":"custom-agent"}

import type { PluginAPI } from '@ampcode/plugin'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const description =
	'Runs task files in fresh orbs with a custom agent defined by files under .amp/orb-tasks/agents.'

type AgentFile = {
	name?: string
	model: `${string}/${string}`
	reasoning_effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
	compaction_threshold_tokens?: number
	tools: string[] | 'all'
}

const TURN_TIMEOUT_MS = 30 * 60 * 1000

function delay(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function stringInput(input: Record<string, unknown>, name: string) {
	const value = input[name]
	if (typeof value !== 'string' || !value) throw new Error(`${name} is required`)
	return value
}

function pathWithin(root: string, directory: string, path: string) {
	if (isAbsolute(path)) throw new Error('paths must be workspace-relative')
	const boundary = resolve(root, directory)
	const candidate = resolve(root, path)
	if (candidate !== boundary && !candidate.startsWith(`${boundary}${sep}`)) {
		throw new Error(`${path} must be under ${directory}`)
	}
	return candidate
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>) {
	return content
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join('')
}

export default function (amp: PluginAPI) {
	const workspaceRoot = amp.system.workspaceRoot
	if (!workspaceRoot) throw new Error('orb-tasks requires a workspace')
	const root = amp.helpers.filePathFromURI(workspaceRoot)
	const agentsDirectory = join(root, '.amp/orb-tasks/agents')
	const tasksDirectory = '.amp/orb-tasks/tasks'
	const outputDirectory = join(root, '.amp/orb-tasks/output')

	const agentNames = readdirSync(agentsDirectory)
		.filter((file) => file.endsWith('.json'))
		.map((file) => file.slice(0, -5))
		.sort()
	if (agentNames.length > 1) {
		throw new Error(`.amp/orb-tasks/agents holds ${agentNames.length} agents; keep exactly one`)
	}

	let loaded: { name: string; agent: ReturnType<typeof amp.createAgent> } | undefined
	if (agentNames.length === 1) {
		const [name] = agentNames
		const config = JSON.parse(
			readFileSync(join(agentsDirectory, `${name}.json`), 'utf8'),
		) as AgentFile
		const instructions = readFileSync(join(agentsDirectory, `${name}.md`), 'utf8')
		const agent = amp.createAgent({
			name: config.name,
			model: config.model,
			instructions,
			tools: config.tools,
			reasoningEffort: config.reasoning_effort,
			compactionThresholdTokens: config.compaction_threshold_tokens,
			display: { label: name.slice(0, 24) },
		})
		amp.registerAgentMode({
			key: 'custom-agent',
			label: 'custom-agent',
			description: `Runs the uploaded agent ${name}.`,
			agent: agent.definition,
		})
		loaded = { name, agent }
	}

	amp.registerTool({
		name: 'run_orb_task',
		title: 'Run task in a fresh orb',
		description:
			'Send the contents of a task file under .amp/orb-tasks/tasks/ as the first message of a fresh orb thread running the uploaded custom agent. Returns the thread ID and where the final answer was written.',
		inputSchema: {
			type: 'object',
			properties: {
				task_path: {
					type: 'string',
					description: 'Workspace-relative task file under .amp/orb-tasks/tasks/.',
				},
				label: {
					type: 'string',
					description: 'Output folder name under .amp/orb-tasks/output/. Defaults to the task file name without extension.',
				},
			},
			required: ['task_path'],
		},
		async execute(input, ctx) {
			if (!loaded) {
				throw new Error('no agent is loaded; upload <name>.json and <name>.md to .amp/orb-tasks/agents and reload plugins')
			}
			const taskPath = pathWithin(root, tasksDirectory, stringInput(input, 'task_path'))
			const task = readFileSync(taskPath, 'utf8')
			if (!task.trim()) throw new Error('task file is empty')
			const label =
				typeof input.label === 'string' && input.label
					? input.label
					: relative(resolve(root, tasksDirectory), taskPath).replace(/\.[^./]+$/, '')
			if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('label may only contain letters, digits, dot, underscore, and dash')

			const child = await loaded.agent.createThread({
				parentThreadID: ctx.thread.id,
				executor: 'orb',
			})
			const directory = join(outputDirectory, label)
			mkdirSync(directory, { recursive: true })
			const answerPath = join(directory, `${child.id}.md`)
			const recordPath = join(directory, `${child.id}.json`)
			const record = {
				agent: loaded.name,
				task_path: relative(root, taskPath),
				thread_id: child.id,
				status: 'running',
			}
			writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)

			try {
				await child.append([{ type: 'user-message', content: task }])
				let answer: string | undefined
				try {
					const response = await child.waitForResponse({ timeoutMs: TURN_TIMEOUT_MS })
					answer = textOf(response.content)
				} catch (waitError) {
					// Orb agent errors can be transient; keep polling this same child until it settles.
					const remote = amp.threads.get(child.id)
					const deadline = Date.now() + TURN_TIMEOUT_MS
					while (Date.now() < deadline) {
						await delay(5_000)
						try {
							if ((await remote.state.get()) !== 'idle') continue
							const [finalMessage] = await remote.messages({
								full: true,
								from: 'end',
								limit: 1,
								roles: ['assistant'],
							})
							answer = finalMessage ? textOf(finalMessage.content) : undefined
							break
						} catch {
							// retry
						}
					}
					if (!answer) throw waitError
				}
				if (!answer) throw new Error('the thread finished without a text answer')
				writeFileSync(answerPath, answer)
				const completed = { ...record, status: 'completed', answer_path: relative(root, answerPath) }
				writeFileSync(recordPath, `${JSON.stringify(completed, null, 2)}\n`)
				return JSON.stringify({
					status: completed.status,
					thread_id: child.id,
					record_path: relative(root, recordPath),
					answer_path: completed.answer_path,
				})
			} catch (error) {
				const failed = {
					...record,
					status: 'error',
					error: error instanceof Error ? error.message : String(error),
				}
				writeFileSync(recordPath, `${JSON.stringify(failed, null, 2)}\n`)
				return JSON.stringify({
					status: failed.status,
					thread_id: child.id,
					record_path: relative(root, recordPath),
					error: failed.error,
				})
			}
		},
	})
}
