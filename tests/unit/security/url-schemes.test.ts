/**
 * Links and images stored for projects and public goods end up in href/src on
 * the front. z.string().url() and new URL() both accept javascript: and data:,
 * so every entry path must also check the scheme.
 */
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../src/services/project/project.service', () => ({ ProjectService: jest.fn() }));
jest.mock('../../../src/services/project/category.service', () => ({ CategoryService: jest.fn() }));

import { publicGoodCreateSchema, publicGoodUpdateSchema } from '../../../src/schemas/publicgood.schema';
import { projectBaseSchema, projectCreateWithUploadSchema } from '../../../src/schemas/project.schema';
import { CsvProjectService } from '../../../src/services/project/csv-project.service';

const hostile = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'javascript:alert(1)//github.com'];
const longBucketUrl = `https://pub-0123.r2.dev/projects/logos/${'a'.repeat(300)}-1761140000000-abcd1234.png`;

describe('public good URL fields', () => {
  for (const [name, schema] of [['create', publicGoodCreateSchema], ['update', publicGoodUpdateSchema]] as const) {
    const body = schema.shape.body.shape;

    it(`${name}: links take http(s) only`, () => {
      for (const field of ['githubUrl', 'demoUrl', 'websiteUrl'] as const) {
        for (const value of hostile) {
          expect(body[field].safeParse(value).success).toBe(false);
        }
      }
      expect(body.websiteUrl.safeParse('https://liquidterminal.xyz').success).toBe(true);
      expect(body.websiteUrl.safeParse('http://example.org').success).toBe(true);
      expect(body.githubUrl.safeParse('https://github.com/liquid/terminal').success).toBe(true);
    });

    it(`${name}: images take https only`, () => {
      for (const field of ['logo', 'banner'] as const) {
        for (const value of [...hostile, 'http://example.org/logo.png', 'anything']) {
          expect(body[field].safeParse(value).success).toBe(false);
        }
        expect(body[field].safeParse(longBucketUrl).success).toBe(true);
        expect(body[field].safeParse({}).success).toBe(true);
        expect(body[field].safeParse(undefined).success).toBe(true);
      }
      expect(body.screenshots.safeParse(['javascript:alert(1)']).success).toBe(false);
      expect(body.screenshots.safeParse(['https://pub-0123.r2.dev/a.png']).success).toBe(true);
    });
  }
});

describe('project URL fields', () => {
  it('with-upload keeps long bucket URLs and refuses other schemes', () => {
    const body = projectCreateWithUploadSchema.shape.body.shape;
    expect(body.logo.safeParse(longBucketUrl).success).toBe(true);
    expect(body.banner.safeParse(longBucketUrl).success).toBe(true);
    for (const value of hostile) {
      expect(body.logo.safeParse(value).success).toBe(false);
      expect(body.website.safeParse(value).success).toBe(false);
    }
  });

  it('the base schema takes https only', () => {
    for (const field of ['logo', 'banner', 'twitter', 'discord', 'telegram', 'website'] as const) {
      expect(projectBaseSchema.shape[field].safeParse('javascript:alert(1)').success).toBe(false);
      expect(projectBaseSchema.shape[field].safeParse('https://liquidterminal.xyz/x.png').success).toBe(true);
    }
  });
});

describe('CSV project import', () => {
  const service = new CsvProjectService() as unknown as { validateRow(row: Record<string, string>): void };
  const row = (extra: Record<string, string>) => ({ title: 'Liquid', desc: 'A terminal', logo: 'logo.png', ...extra });

  it('refuses links and logos that are not web URLs', () => {
    for (const value of hostile) {
      expect(() => service.validateRow(row({ website: value }))).toThrow();
      expect(() => service.validateRow(row({ logo: value }))).toThrow();
    }
  });

  it('keeps web links, file names and the t.me fix-up', () => {
    expect(() => service.validateRow(row({ website: 'https://liquidterminal.xyz', twitter: 'http://x.com/lt' }))).not.toThrow();
    expect(() => service.validateRow(row({ logo: 'https://pub-0123.r2.dev/logo.png' }))).not.toThrow();
    const fixed = row({ telegram: 't.me/liquid' });
    service.validateRow(fixed);
    expect(fixed.telegram).toBe('https://t.me/liquid');
  });
});
