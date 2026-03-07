export interface BaseAuthContext {
  userId: string;
  projectId: string;
  environmentId: string;
  providerId?: string;
  entityId?: string;
  isMaster: boolean;
}

export interface ApiKeyAuthContext extends BaseAuthContext {
  authType: 'api_key';
  apiKey: string;
  apiKeyId: string;
  apiKeyPrefix: string;
  environmentName?: string;
  project?: any;
  environment?: any;
  provider?: any;
  entity?: any;
}

export interface SessionAuthContext extends BaseAuthContext {
  authType: 'session';
  sessionId: string;
  userEmail: string;
  userName?: string | null;
}

export type UnifiedAuthContext = ApiKeyAuthContext | SessionAuthContext;

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  metadata?: any;
  onboardingComplete?: boolean;
  isActive?: boolean;
}

export interface UserSession {
  user: SessionUser;
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
}

export type ApiKeyExtractor = (c: any) => string | undefined | Promise<string | undefined>;

export interface ApiKeyExtractorConfig {
  name: string;
  extractor: ApiKeyExtractor;
  priority: number;
}

export interface AuthMiddlewareConfig {
  requireAuth?: boolean;
  skipPaths?: string[];
  enableApiKeyAuth?: boolean;
  enableSessionAuth?: boolean;
  requireProjectEnv?: boolean;
  hydrateSessionUserFromDb?: boolean;
}

export interface SessionValidationResult {
  user: SessionUser;
  session: UserSession['session'];
}
