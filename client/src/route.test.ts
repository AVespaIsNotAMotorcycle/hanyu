import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, type Route } from './route';

describe('routes', () => {
  const routes: [string, Route][] = [
    ['/', { name: 'today' }],
    ['/read', { name: 'read' }],
    ['/read/p1-0001', { name: 'read', passage: 'p1-0001' }],
    ['/listen', { name: 'listen' }],
    ['/listen/l1-0001', { name: 'listen', exercise: 'l1-0001' }],
    ['/grammar', { name: 'grammar' }],
    ['/grammar/p1-0001', { name: 'grammar', passage: 'p1-0001' }],
    ['/progress', { name: 'progress' }],
    ['/settings', { name: 'settings' }],
    ['/study/review', { name: 'study', mode: 'review' }],
    ['/study/new', { name: 'study', mode: 'new' }],
    ['/study/flagged', { name: 'study', mode: 'flagged' }],
  ];

  it.each(routes)('%s goes both ways', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
    expect(routePath(route)).toBe(path);
  });

  it('ignores a trailing slash', () => {
    expect(parseRoute('/read/')).toEqual({ name: 'read' });
  });

  it('escapes IDs', () => {
    const route: Route = { name: 'read', passage: 'a/b c' };
    expect(routePath(route)).toBe('/read/a%2Fb%20c');
    expect(parseRoute(routePath(route))).toEqual(route);
  });

  it.each([
    '/nowhere',
    '/read/a/b',
    '/progress/1',
    '/study',
    '/study/everything',
    '/read/%E0%A4%A',
  ])('shows Today for %s', (path) => {
    expect(parseRoute(path)).toEqual({ name: 'today' });
  });
});
