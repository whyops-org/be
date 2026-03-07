import env from './env';

export interface WhyopsCorsOptions {
  origin: string[];
  allowMethods: string[];
  allowHeaders: string[];
  credentials: boolean;
  maxAge: number;
}

export const WHYOPS_CORS_OPTIONS: WhyopsCorsOptions = {
  origin: [env.PROXY_URL, env.ANALYSE_URL, env.AUTH_URL, 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: env.CORS_MAX_AGE_SEC,
};

export function getWhyopsCorsOptions(): WhyopsCorsOptions {
  return {
    origin: [...WHYOPS_CORS_OPTIONS.origin],
    allowMethods: [...WHYOPS_CORS_OPTIONS.allowMethods],
    allowHeaders: [...WHYOPS_CORS_OPTIONS.allowHeaders],
    credentials: WHYOPS_CORS_OPTIONS.credentials,
    maxAge: WHYOPS_CORS_OPTIONS.maxAge,
  };
}

export interface IntegrationCorsOptions {
  origin: (origin: string) => string;
  allowMethods: string[];
  allowHeaders: string[];
  credentials: boolean;
  maxAge: number;
}

export function getIntegrationCorsOptions(): IntegrationCorsOptions {
  return {
    origin: (origin: string) => origin,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Session-Key',
      'X-Agent-Name',
      'X-Trace-ID',
      'X-Thread-ID',
      'X-User-Id',
      'X-Project-Id',
      'X-Environment-Id',
      'X-Provider-Id',
    ],
    credentials: true,
    maxAge: env.CORS_MAX_AGE_SEC,
  };
}
