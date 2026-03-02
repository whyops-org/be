import env, { getTrustedOrigins } from '@whyops/shared/env';
import { buildPgSslConfig, logger, parseDatabaseUrl } from '@whyops/shared/utils';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { sendMagicLinkEmail } from '../utils/email.util';

const parsedDbUrl = env.DATABASE_URL ? parseDatabaseUrl(env.DATABASE_URL) : null;

const poolConfig = env.DATABASE_URL
  ? {
      connectionString: env.DATABASE_URL,
      host: parsedDbUrl?.host,
      port: parsedDbUrl?.port,
      database: parsedDbUrl?.database,
      user: parsedDbUrl?.username,
    }
  : {
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_NAME,
      user: env.DB_USER,
    };

const ssl = buildPgSslConfig({
  databaseUrl: env.DATABASE_URL,
  dbHost: parsedDbUrl?.host || env.DB_HOST,
  explicitSsl: env.DB_SSL,
  rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED,
});

// Create Kysely instance for Better Auth
const db = new Kysely({
  dialect: new PostgresDialect({
    pool: new Pool({
      ...poolConfig,
      password: env.DB_PASSWORD,
      max: env.DB_POOL_MAX,
      min: env.DB_POOL_MIN,
      ssl,
    }),
  }),
});

logger.info(
  {
    baseURL: env.BETTER_AUTH_URL,
    dbHost: parsedDbUrl?.host || env.DB_HOST,
    dbPort: parsedDbUrl?.port || env.DB_PORT,
    dbName: parsedDbUrl?.database || env.DB_NAME,
    dbSslEnabled: ssl !== false,
    dbSslRejectUnauthorized: ssl !== false ? ssl.rejectUnauthorized : false,
  },
  'Initialized Kysely database connection for Better Auth'
);

// Configure Better Auth
export const auth = betterAuth({
  database: {
    db,
    type: 'postgres',
  } as any,
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url, token }, ctx) => {
        // Send magic link email asynchronously (avoid timing attacks)
        // The 'url' already contains the verification token and callbackURL
        // When user clicks the link, Better Auth automatically:
        // 1. Verifies the token
        // 2. Creates a session
        // 3. Redirects to the callbackURL (or '/' if not provided)
        void sendMagicLinkEmail({
          to: email,
          magicLinkUrl: url,
        });
      },
      expiresIn: 60 * 15, // 15 minutes
      disableSignUp: false, // Allow new users to sign up via magic link
    }),
  ],
  socialProviders: {
    github: env.AUTHGH_CLIENT_ID && env.AUTHGH_CLIENT_SECRET ? {
      clientId: env.AUTHGH_CLIENT_ID,
      clientSecret: env.AUTHGH_CLIENT_SECRET,
    } : undefined,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    } : undefined,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day - update session if older than this
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  user: {
    additionalFields: {
      organizationId: {
        type: 'string',
        required: false,
      },
    },
  },
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      // Sync Better Auth user with Sequelize users table
      // This catches: sign-up, magic link verification, OAuth sign-ins
      const newSession = ctx.context.newSession;
      
      if (newSession?.user) {
        const betterAuthUser = newSession.user;
        try {
          const { User } = await import('@whyops/shared/models');
          
          // Check if Sequelize user already exists
          const existingUser = await User.findOne({ 
            where: { email: betterAuthUser.email } 
          });
          
          if (!existingUser) {
            // Create corresponding Sequelize user with same ID
            await User.create({
              id: betterAuthUser.id,
              email: betterAuthUser.email,
              name: betterAuthUser.name || undefined,
              passwordHash: 'managed_by_better_auth', // Placeholder since Better Auth manages auth
              isActive: true,
              organizationId: (betterAuthUser as any).organizationId || undefined,
            });
            logger.info(`✅ Synced Better Auth user ${betterAuthUser.id} (${betterAuthUser.email}) to Sequelize users table`);
          }
        } catch (error) {
          logger.error('❌ Failed to sync user to Sequelize:');
        }
      }
    }),
  },
  advanced: {
    defaultCookieAttributes: {
      sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
      httpOnly: true,
      path: '/',
      domain: env.COOKIE_DOMAIN || undefined,
      secure: env.NODE_ENV === 'production',
    },
    useSecureCookies: env.NODE_ENV === 'production',
  },
  trustedOrigins: [
    env.PROXY_URL,
    env.ANALYSE_URL,
    env.AUTH_URL,
    ...getTrustedOrigins(),
  ],
});

export type Auth = typeof auth;
