import { createServiceLogger } from '@whyops/shared/logger';
import { Context } from 'hono';
import { CreateProjectData, ProjectService, UpdateProjectData } from '../services';
import { ResponseUtil } from '../utils';

const logger = createServiceLogger('auth:project-controller');

export class ProjectController {
  static async listProjects(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const projects = await ProjectService.listProjects(user.id);
      return ResponseUtil.success(c, { projects });
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch projects');
      return ResponseUtil.internalError(c, 'Failed to fetch projects');
    }
  }

  static async getProject(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const projectId = c.req.param('id');
      if (!projectId) {
        return ResponseUtil.badRequest(c, 'Missing route parameter: id');
      }
      
      const project = await ProjectService.getProjectById(projectId, user.id);

      if (!project) {
        return ResponseUtil.notFound(c, 'Project not found');
      }

      return ResponseUtil.success(c, { project });
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch project');
      return ResponseUtil.internalError(c, 'Failed to fetch project');
    }
  }

  static async createProject(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const data = await c.req.json();
      
      const result = await ProjectService.createProject({
        userId: user.id,
        ...data,
      } as CreateProjectData);

      return ResponseUtil.created(c, {
        project: {
          id: result.project.id,
          name: result.project.name,
          description: result.project.description,
          isActive: result.project.isActive,
          createdAt: result.project.createdAt,
        },
        environments: result.environments.map((env: any) => ({
          id: env.id,
          name: env.name,
          description: env.description,
          isActive: env.isActive,
          createdAt: env.createdAt,
        })),
        masterKeys: result.masterKeys,
        warning: 'Save these master API keys securely. You will not be able to retrieve them again.',
      });
    } catch (error: any) {
      logger.error({ error }, 'Failed to create project');

      if (error.message === 'A project with this name already exists') {
        return ResponseUtil.conflict(c, error.message);
      }

      return ResponseUtil.internalError(c, 'Failed to create project');
    }
  }

  static async updateProject(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const projectId = c.req.param('id');
      if (!projectId) {
        return ResponseUtil.badRequest(c, 'Missing route parameter: id');
      }
      const data = await c.req.json() as UpdateProjectData;
      
      const project = await ProjectService.updateProject(projectId, user.id, data);

      return ResponseUtil.success(c, { project });
    } catch (error: any) {
      logger.error({ error }, 'Failed to update project');
      
      if (error.message === 'Project not found') {
        return ResponseUtil.notFound(c, error.message);
      }
      
      return ResponseUtil.internalError(c, 'Failed to update project');
    }
  }

  static async deleteProject(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const projectId = c.req.param('id');
      if (!projectId) {
        return ResponseUtil.badRequest(c, 'Missing route parameter: id');
      }
      
      await ProjectService.deactivateProject(projectId, user.id);

      return ResponseUtil.success(c, { message: 'Project deactivated successfully' });
    } catch (error: any) {
      logger.error({ error }, 'Failed to delete project');
      
      if (error.message === 'Project not found') {
        return ResponseUtil.notFound(c, error.message);
      }
      
      return ResponseUtil.internalError(c, 'Failed to delete project');
    }
  }

  static async getEnvironments(c: Context) {
    try {
      const user = c.get('sessionUser');
      if (!user) {
        return ResponseUtil.unauthorized(c, 'Not authenticated');
      }
      const projectId = c.req.param('projectId');
      if (!projectId) {
        return ResponseUtil.badRequest(c, 'Missing route parameter: projectId');
      }
      
      const environments = await ProjectService.getEnvironments(projectId, user.id);

      return ResponseUtil.success(c, { environments });
    } catch (error: any) {
      logger.error({ error }, 'Failed to fetch environments');
      
      if (error.message === 'Project not found') {
        return ResponseUtil.notFound(c, error.message);
      }
      
      return ResponseUtil.internalError(c, 'Failed to fetch environments');
    }
  }
}
