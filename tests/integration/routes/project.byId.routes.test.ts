/**
 * GET /project/:id — `ProjectService.getById` throws ProjectNotFoundError on
 * an unknown id (it never returns null): the route answers 404, not 500, so
 * the front shows "Project not found" at once instead of retrying.
 */
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

const mockGetById = jest.fn();
const pass = (_req: Request, _res: Response, next: NextFunction) => next();

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/middleware/apiRateLimiter', () => ({ marketRateLimiter: pass }));
jest.mock('../../../src/middleware/authMiddleware', () => ({ validatePrivyToken: pass }));
jest.mock('../../../src/middleware/roleMiddleware', () => ({ requireModerator: pass, requireAdmin: pass }));
jest.mock('../../../src/middleware/upload-r2.middleware', () => ({
  uploadProjectFilesR2: pass,
  validateAndUploadToR2: pass,
  handleUploadErrorR2: pass,
  getUploadedUrls: () => ({}),
}));
jest.mock('../../../src/services/defillama/defillama.service', () => ({
  DefiLlamaService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/defillama/defillama-context.service', () => ({
  DefiLlamaContextService: { getInstance: () => ({}) },
}));
jest.mock('../../../src/services/project/project.service', () => ({
  ProjectService: jest.fn().mockImplementation(() => ({ getById: mockGetById })),
}));

import projectRoutes from '../../../src/routes/project/project.routes';
import { ProjectNotFoundError } from '../../../src/errors/project.errors';

const app = express();
app.use('/project', projectRoutes);

describe('GET /project/:id', () => {
  beforeEach(() => {
    mockGetById.mockReset();
  });

  it('answers the project', async () => {
    mockGetById.mockResolvedValue({ id: 7, title: 'HyperSwap' });

    const res = await request(app).get('/project/7');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 7, title: 'HyperSwap' });
    expect(mockGetById).toHaveBeenCalledWith(7);
  });

  it('answers 404 for an unknown id', async () => {
    mockGetById.mockRejectedValue(new ProjectNotFoundError());

    const res = await request(app).get('/project/999999');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Projet non trouvé' });
  });

  it('answers 400 for an id that is not a number', async () => {
    const res = await request(app).get('/project/abc');

    expect(res.status).toBe(400);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('still answers 500 for any other failure', async () => {
    mockGetById.mockRejectedValue(new Error('connection refused'));

    const res = await request(app).get('/project/7');

    expect(res.status).toBe(500);
  });
});
