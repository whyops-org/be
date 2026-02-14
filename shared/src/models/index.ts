import Agent from './Agent';
import ApiKey from './ApiKey';
import Entity from './Entity';
import { Environment } from './Environment';
import LlmCost from './LlmCost';
import LLMEvent from './LLMEvent';
import { Project } from './Project';
import Provider from './Provider';
import RequestLog from './RequestLog';
import Trace from './Trace';
import User from './User';

// Define associations

// User -> Project
User.hasMany(Project, { foreignKey: 'userId', as: 'projects' });
Project.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Project -> Environment
Project.hasMany(Environment, { foreignKey: 'projectId', as: 'environments' });
Environment.belongsTo(Project, { foreignKey: 'projectId', as: 'project' });

// User -> Provider
User.hasMany(Provider, { foreignKey: 'userId', as: 'providers' });
Provider.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// User -> ApiKey
User.hasMany(ApiKey, { foreignKey: 'userId', as: 'apiKeys' });
ApiKey.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Project -> ApiKey
Project.hasMany(ApiKey, { foreignKey: 'projectId', as: 'apiKeys' });
ApiKey.belongsTo(Project, { foreignKey: 'projectId', as: 'project' });

// Environment -> ApiKey
Environment.hasMany(ApiKey, { foreignKey: 'environmentId', as: 'apiKeys' });
ApiKey.belongsTo(Environment, { foreignKey: 'environmentId', as: 'environment' });

// Provider -> ApiKey (optional)
Provider.hasMany(ApiKey, { foreignKey: 'providerId', as: 'apiKeys' });
ApiKey.belongsTo(Provider, { foreignKey: 'providerId', as: 'provider' });

// Entity -> ApiKey (optional)
Entity.hasMany(ApiKey, { foreignKey: 'entityId', as: 'apiKeys' });
ApiKey.belongsTo(Entity, { foreignKey: 'entityId', as: 'entity' });

// User -> LLMEvent
User.hasMany(LLMEvent, { foreignKey: 'userId', as: 'events' });
LLMEvent.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Provider -> LLMEvent
Provider.hasMany(LLMEvent, { foreignKey: 'providerId', as: 'events' });
LLMEvent.belongsTo(Provider, { foreignKey: 'providerId', as: 'providerDetails' });

// Trace associations
Trace.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(Trace, { foreignKey: 'userId', as: 'traces' });

Trace.hasMany(LLMEvent, { foreignKey: 'traceId', sourceKey: 'id', as: 'events' });
LLMEvent.belongsTo(Trace, { foreignKey: 'traceId', targetKey: 'id', as: 'trace' });

// Entity associations
User.hasMany(Entity, { foreignKey: 'userId', as: 'entities' });
Entity.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(Agent, { foreignKey: 'userId', as: 'agents' });
Agent.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Project -> Entity
Project.hasMany(Entity, { foreignKey: 'projectId', as: 'entities' });
Entity.belongsTo(Project, { foreignKey: 'projectId', as: 'project' });

Project.hasMany(Agent, { foreignKey: 'projectId', as: 'agents' });
Agent.belongsTo(Project, { foreignKey: 'projectId', as: 'project' });

// Environment -> Entity
Environment.hasMany(Entity, { foreignKey: 'environmentId', as: 'entities' });
Entity.belongsTo(Environment, { foreignKey: 'environmentId', as: 'environment' });

Environment.hasMany(Agent, { foreignKey: 'environmentId', as: 'agents' });
Agent.belongsTo(Environment, { foreignKey: 'environmentId', as: 'environment' });

Agent.hasMany(Entity, { foreignKey: 'agentId', as: 'versions' });
Entity.belongsTo(Agent, { foreignKey: 'agentId', as: 'agent' });

LLMEvent.belongsTo(Entity, { foreignKey: 'entityId', as: 'entity' });

Trace.belongsTo(Entity, { foreignKey: 'entityId', as: 'entity' });
Entity.hasMany(Trace, { foreignKey: 'entityId', as: 'traces' });

export { Agent, ApiKey, Entity, Environment, LlmCost, LLMEvent, Project, Provider, RequestLog, Trace, User };

export const models = {
  User,
  Agent,
  Provider,
  ApiKey,
  LLMEvent,
  RequestLog,
  Trace,
  Entity,
  LlmCost,
  Project,
  Environment,
};

export default models;
