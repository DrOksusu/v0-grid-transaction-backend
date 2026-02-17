import { BaseAgent } from './base-agent';
import { AgentInfo } from './types';

export class AgentManager {
  private static instance: AgentManager;
  private agents: Map<string, BaseAgent> = new Map();

  private constructor() {}

  static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      AgentManager.instance = new AgentManager();
    }
    return AgentManager.instance;
  }

  register(agent: BaseAgent): void {
    if (this.agents.has(agent.id)) {
      console.warn(`[AgentManager] Agent '${agent.id}' already registered, replacing`);
    }
    this.agents.set(agent.id, agent);
    console.log(`[AgentManager] Registered: ${agent.name} (${agent.id})`);
  }

  unregister(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn(`[AgentManager] Agent '${agentId}' not found`);
      return;
    }
    this.agents.delete(agentId);
    console.log(`[AgentManager] Unregistered: ${agentId}`);
  }

  getAgent(id: string): BaseAgent | undefined {
    return this.agents.get(id);
  }

  getAllAgents(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  async startAll(): Promise<void> {
    console.log(`[AgentManager] Starting all agents (${this.agents.size})`);
    const results = await Promise.allSettled(
      Array.from(this.agents.values()).map(agent => agent.start())
    );

    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        const agent = Array.from(this.agents.values())[idx];
        console.error(`[AgentManager] Failed to start ${agent.id}:`, result.reason?.message);
      }
    });
  }

  async stopAll(): Promise<void> {
    console.log(`[AgentManager] Stopping all agents (${this.agents.size})`);
    const results = await Promise.allSettled(
      Array.from(this.agents.values()).map(agent => agent.stop())
    );

    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        const agent = Array.from(this.agents.values())[idx];
        console.error(`[AgentManager] Failed to stop ${agent.id}:`, result.reason?.message);
      }
    });
  }

  getAllStatus(): AgentInfo[] {
    return Array.from(this.agents.values()).map(agent => agent.getStatus());
  }

  getMetrics(): Record<string, any> {
    const statuses = this.getAllStatus();
    return {
      totalAgents: statuses.length,
      running: statuses.filter(s => s.status === 'running').length,
      stopped: statuses.filter(s => s.status === 'stopped').length,
      idle: statuses.filter(s => s.status === 'idle').length,
      error: statuses.filter(s => s.status === 'error').length,
      agents: statuses,
    };
  }
}

export const agentManager = AgentManager.getInstance();
