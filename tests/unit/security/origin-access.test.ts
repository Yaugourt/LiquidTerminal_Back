/**
 * What a browser page may do with the API by its origin: our pages everything, a preview
 * deployment of the front reading, any other site nothing.
 */
import { originAccess, previewOriginPattern } from '../../../src/utils/originAccess';
import { SECURITY_CONSTANTS } from '../../../src/constants/security.constants';

const SCOPE = SECURITY_CONSTANTS.PREVIEW_SCOPE;
const PROJECT = SECURITY_CONSTANTS.PREVIEW_PROJECT;

describe('originAccess', () => {
  it('gives our own pages everything', () => {
    for (const origin of SECURITY_CONSTANTS.ALLOWED_ORIGINS) expect(originAccess(origin)).toBe('full');
  });

  // Addresses Vercel generated for this project in November 2026, as GitHub lists them.
  it.each([
    `https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app`,
    `https://${PROJECT}-4nk22lukz-${SCOPE}.vercel.app`,
    `https://${PROJECT}-l5u0lbtky-${SCOPE}.vercel.app`,
    `https://${PROJECT}-git-d-a1d01b-${SCOPE}.vercel.app`,
    `https://${PROJECT}-git-c-883adf-${SCOPE}.vercel.app`,
    `https://${PROJECT}-git-main-${SCOPE}.vercel.app`,
  ])('lets a preview read: %s', (origin) => {
    expect(originAccess(origin)).toBe('read');
  });

  it.each([
    // Another scheme, port, host or suffix.
    `http://${PROJECT}-59mwf5195-${SCOPE}.vercel.app`,
    `https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app:8443`,
    `https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app.evil.example`,
    `https://evil.example/${PROJECT}-59mwf5195-${SCOPE}.vercel.app`,
    `https://${PROJECT}-59mwf5195-${SCOPE}.vercel.dev`,
    `https://${PROJECT}-59mwf5195-${SCOPE}xvercel.app`,
    // Another project, another team, or a subdomain that only ends like ours.
    `https://other-front-59mwf5195-${SCOPE}.vercel.app`,
    `https://x${PROJECT}-59mwf5195-${SCOPE}.vercel.app`,
    `https://${PROJECT}-59mwf5195-someone-elses-projects.vercel.app`,
    `https://evil.${PROJECT}-59mwf5195-${SCOPE}.vercel.app`,
    // Not a commit's nine letters or digits, not a branch.
    `https://${PROJECT}-59mwf519-${SCOPE}.vercel.app`,
    `https://${PROJECT}-59mwf51955-${SCOPE}.vercel.app`,
    `https://${PROJECT}-59MWF5195-${SCOPE}.vercel.app`,
    `https://${PROJECT}-evil-page-${SCOPE}.vercel.app`,
    `https://${PROJECT}-git--${SCOPE}.vercel.app`,
    `https://${PROJECT}-git-a.b-${SCOPE}.vercel.app`,
    `https://${PROJECT}-${SCOPE}.vercel.app`,
    // Trailing text, line breaks, nothing at all.
    `https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app/`,
    `https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app\nhttps://evil.example`,
    `https://evil.example\nhttps://${PROJECT}-59mwf5195-${SCOPE}.vercel.app`,
    'https://evil.vercel.app',
    'https://evil.example',
    'null',
    '',
  ])('gives any other site nothing: %j', (origin) => {
    expect(originAccess(origin)).toBe('none');
  });
});

describe('previewOriginPattern', () => {
  it('follows the project to another team', () => {
    const pattern = previewOriginPattern(PROJECT, 'new-team');
    expect(pattern?.test(`https://${PROJECT}-59mwf5195-new-team.vercel.app`)).toBe(true);
    expect(pattern?.test(`https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app`)).toBe(false);
  });

  it.each(['false', '', '*', '.*', 'a|b', 'team.vercel', 'Team', '-team', 'team-', 'a b'])(
    'opens nothing for %j, which is not a team',
    (scope) => {
      expect(previewOriginPattern(PROJECT, scope)).toBeNull();
    }
  );
});

describe('PREVIEW_VERCEL_SCOPE', () => {
  const load = (scope?: string): typeof originAccess => {
    jest.resetModules();
    if (scope === undefined) delete process.env.PREVIEW_VERCEL_SCOPE;
    else process.env.PREVIEW_VERCEL_SCOPE = scope;
    return require('../../../src/utils/originAccess').originAccess;
  };
  afterEach(() => {
    delete process.env.PREVIEW_VERCEL_SCOPE;
  });

  it('switches the previews off, and leaves our pages alone', () => {
    const access = load('false');
    expect(access(`https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app`)).toBe('none');
    expect(access('https://liquidterminal.xyz')).toBe('full');
  });

  it('names another team', () => {
    const access = load('new-team');
    expect(access(`https://${PROJECT}-59mwf5195-new-team.vercel.app`)).toBe('read');
    expect(access(`https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app`)).toBe('none');
  });

  it('unset or empty, the default team', () => {
    expect(load()(`https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app`)).toBe('read');
    expect(load('')(`https://${PROJECT}-59mwf5195-${SCOPE}.vercel.app`)).toBe('read');
  });
});
