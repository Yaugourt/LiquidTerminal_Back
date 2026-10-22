import { z } from 'zod';

// z.string().url() accepts any scheme (javascript:, data:…): links must be web
// URLs, and images only ever come from our https bucket.
const WEB_URL = /^https?:\/\//i;
const HTTPS_URL = /^https:\/\//i;

// Schema pour la création d'un Public Good (avec gestion FormData)
export const publicGoodCreateSchema = z.object({
  body: z.object({
    // Section 1: Le projet (Required)
    name: z.string()
      .min(3, 'Name must be at least 3 characters')
      .max(255, 'Name cannot exceed 255 characters')
      .trim(),
    
    description: z.string()
      .min(100, 'Description must be at least 100 characters')
      .trim(),
    
    githubUrl: z.string()
      .url('GitHub URL must be valid')
      .regex(WEB_URL, 'Only http(s) URLs are allowed')
      .regex(/github\.com/, 'Must be a valid GitHub URL'),
    
    demoUrl: z.string().url('Demo URL must be valid').regex(WEB_URL, 'Only http(s) URLs are allowed').optional(),
    websiteUrl: z.string().url('Website URL must be valid').regex(WEB_URL, 'Only http(s) URLs are allowed').optional(),
    
    category: z.string()
      .min(3, 'Category must be at least 3 characters')
      .max(100, 'Category cannot exceed 100 characters')
      .trim(),
    
    discordContact: z.string().optional(),
    telegramContact: z.string().optional(),

    // Visuels (optionnels car gérés par upload)
    logo: z.union([
      z.string().regex(HTTPS_URL, 'Only https image URLs are allowed'),
      z.object({}).optional(), // Pour FormData vides
    ]).optional(),
    
    banner: z.union([
      z.string().regex(HTTPS_URL, 'Only https image URLs are allowed'),
      z.object({}).optional(),
    ]).optional(),
    
    screenshots: z.union([
      z.array(z.string().url().regex(HTTPS_URL, 'Only https image URLs are allowed')).optional(),
      z.string().optional() // JSON stringifié
    ]).optional(),

    // Section 2: Impact HyperLiquid (Required)
    problemSolved: z.string()
      .min(50, 'Problem solved must be at least 50 characters')
      .trim(),
    
    targetUsers: z.union([
      z.array(z.string()),
      z.string() // JSON stringifié: '["developers","traders"]'
    ]).transform(val => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return [val];
        }
      }
      return val;
    }).refine(val => Array.isArray(val) && val.length > 0, {
      message: 'At least one target user is required'
    }),
    
    hlIntegration: z.string()
      .min(50, 'HyperLiquid integration description must be at least 50 characters')
      .trim(),
    
    developmentStatus: z.enum(['IDEA', 'DEVELOPMENT', 'BETA', 'PRODUCTION']),

    // Section 3: Équipe & Technique (Required)
    leadDeveloperName: z.string()
      .min(2, 'Lead developer name must be at least 2 characters')
      .max(255, 'Lead developer name cannot exceed 255 characters')
      .trim(),
    
    leadDeveloperContact: z.string()
      .email('Lead developer contact must be a valid email'),
    
    teamSize: z.enum(['SOLO', 'SMALL', 'LARGE']),
    experienceLevel: z.enum(['BEGINNER', 'INTERMEDIATE', 'EXPERT']),
    
    technologies: z.union([
      z.array(z.string()),
      z.string() // JSON stringifié: '["Python","React"]'
    ]).transform(val => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return [val];
        }
      }
      return val;
    }).refine(val => Array.isArray(val) && val.length > 0, {
      message: 'At least one technology is required'
    }),

    // Section 4: Soutien demandé (Optionnel)
    supportTypes: z.union([
      z.array(z.enum(['PROMOTION', 'SERVICES', 'FUNDING', 'CONTRIBUTOR'])),
      z.string() // JSON stringifié
    ]).transform(val => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return [];
        }
      }
      return val;
    }).optional(),
    
    contributorTypes: z.union([
      z.array(z.enum(['DEVELOPERS', 'DESIGNERS', 'MARKETING_COMMUNITY', 'TECHNICAL_WRITERS', 'QA_TESTERS'])),
      z.string() // JSON stringifié
    ]).transform(val => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return [];
        }
      }
      return val;
    }).optional(),
    
    budgetRange: z.enum(['RANGE_0_5K', 'RANGE_5_15K', 'RANGE_15_30K', 'RANGE_30_50K', 'RANGE_50K_PLUS']).optional()
  }),
  params: z.object({}),
  query: z.object({})
});

// Schema pour la mise à jour (tous les champs optionnels)
export const publicGoodUpdateSchema = z.object({
  body: z.object({
    name: z.string().min(3).max(255).trim().optional(),
    description: z.string().min(100).trim().optional(),
    githubUrl: z.string().url().regex(WEB_URL).regex(/github\.com/).optional(),
    demoUrl: z.string().url().regex(WEB_URL, 'Only http(s) URLs are allowed').optional(),
    websiteUrl: z.string().url().regex(WEB_URL, 'Only http(s) URLs are allowed').optional(),
    category: z.string().min(3).max(100).trim().optional(),
    discordContact: z.string().optional(),
    telegramContact: z.string().optional(),
    
    logo: z.union([
      z.string().regex(HTTPS_URL, 'Only https image URLs are allowed'),
      z.object({}).optional(),
    ]).optional(),
    
    banner: z.union([
      z.string().regex(HTTPS_URL, 'Only https image URLs are allowed'),
      z.object({}).optional(),
    ]).optional(),
    
    screenshots: z.union([
      z.array(z.string().url().regex(HTTPS_URL, 'Only https image URLs are allowed')).optional(),
      z.string().optional()
    ]).optional(),
    
    problemSolved: z.string().min(50).trim().optional(),
    
    targetUsers: z.union([
      z.array(z.string()),
      z.string()
    ]).transform(val => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return [val];
        }
      }
      return val;
    }).optional(),
    
    hlIntegration: z.string().min(50).trim().optional(),
    developmentStatus: z.enum(['IDEA', 'DEVELOPMENT', 'BETA', 'PRODUCTION']).optional(),
    leadDeveloperName: z.string().min(2).max(255).trim().optional(),
    leadDeveloperContact: z.string().email().optional(),
    teamSize: z.enum(['SOLO', 'SMALL', 'LARGE']).optional(),
    experienceLevel: z.enum(['BEGINNER', 'INTERMEDIATE', 'EXPERT']).optional(),
    
    technologies: z.union([
      z.array(z.string()),
      z.string()
    ]).transform(val => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return [val];
        }
      }
      return val;
    }).optional(),
    
    supportTypes: z.union([
      z.array(z.enum(['PROMOTION', 'SERVICES', 'FUNDING', 'CONTRIBUTOR'])),
      z.string()
    ]).transform(val => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return [];
        }
      }
      return val;
    }).optional(),
    
    contributorTypes: z.union([
      z.array(z.enum(['DEVELOPERS', 'DESIGNERS', 'MARKETING_COMMUNITY', 'TECHNICAL_WRITERS', 'QA_TESTERS'])),
      z.string()
    ]).transform(val => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return [];
        }
      }
      return val;
    }).optional(),
    
    budgetRange: z.enum(['RANGE_0_5K', 'RANGE_5_15K', 'RANGE_15_30K', 'RANGE_30_50K', 'RANGE_50K_PLUS']).optional()
  }),
  params: z.object({
    id: z.string().transform(val => parseInt(val))
  }),
  query: z.object({})
});

// Schema pour review
export const publicGoodReviewSchema = z.object({
  body: z.object({
    status: z.enum(['APPROVED', 'REJECTED']),
    reviewNotes: z.string().optional()
  }),
  params: z.object({
    id: z.string().transform(val => parseInt(val))
  }),
  query: z.object({})
});

// Schema pour les query params
export const publicGoodQuerySchema = z.object({
  params: z.object({}),
  body: z.object({}),
  query: z.object({
    page: z.string().transform(val => parseInt(val)).pipe(z.number().int().positive()).optional(),
    limit: z.string().transform(val => parseInt(val)).pipe(z.number().int().positive()).optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'all']).optional().default('approved'),
    category: z.string().optional(),
    search: z.string().max(100).optional(),
    developmentStatus: z.enum(['IDEA', 'DEVELOPMENT', 'BETA', 'PRODUCTION']).optional(),
    sort: z.enum(['submittedAt', 'name', 'updatedAt', 'createdAt']).optional().default('submittedAt'),
    order: z.enum(['asc', 'desc']).optional().default('desc')
  })
});

