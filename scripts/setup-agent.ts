// Create (or update) and start both agents. Safe to re-run after config changes.
import { ensureAgents } from '../src/zoowork.ts'

console.log(await ensureAgents())
