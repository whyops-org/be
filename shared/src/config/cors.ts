import env from './env';

export interface WhyopsCorsOptions {
  origin: string[];
  allowMethods: string[];
  allowHeaders: string[];
  credentials: boolean;
}

export const WHYOPS_CORS_OPTIONS: WhyopsCorsOptions = {
  origin: [env.PROXY_URL, env.ANALYSE_URL, env.AUTH_URL, 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

export function getWhyopsCorsOptions(): WhyopsCorsOptions {
  return {
    origin: [...WHYOPS_CORS_OPTIONS.origin],
    allowMethods: [...WHYOPS_CORS_OPTIONS.allowMethods],
    allowHeaders: [...WHYOPS_CORS_OPTIONS.allowHeaders],
    credentials: WHYOPS_CORS_OPTIONS.credentials,
  };
}
