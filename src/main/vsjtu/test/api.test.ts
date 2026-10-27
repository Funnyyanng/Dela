import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  replies: [] as unknown[],
  urls: [] as string[],
  statuses: [] as number[],
  cookieChange: undefined as ((event: unknown, cookie: { domain?: string }) => void) | undefined,
  beforeResponse: undefined as ((url: string) => void) | undefined,
}));
vi.mock('electron', () => ({
  net: {
    request: ({ url }: { url: string }) => {
      server.urls.push(url);
      const request = new EventEmitter() as EventEmitter & {
        end(): void;
        abort(): void;
        setHeader(): void;
      };
      request.abort = () => {};
      request.setHeader = () => {};
      request.end = () =>
        queueMicrotask(() => {
          server.beforeResponse?.(url);
          const response = Object.assign(new EventEmitter(), {
            statusCode: server.statuses.shift() ?? 200,
          });
          request.emit('response', response);
          response.emit('data', Buffer.from(JSON.stringify(server.replies.shift())));
          response.emit('end');
        });
      return request;
    },
  },
}));
vi.mock('../../campus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../campus')>()),
  getCampusSession: async () => ({
    cookies: {
      on: (_event: string, listener: typeof server.cookieChange) => {
        server.cookieChange = listener;
      },
    },
  }),
}));
import { checkVideoLogin, listCourses, listVideos, parseStreams } from '../api';

beforeEach(() => {
  server.cookieChange?.({}, { domain: 'v.sjtu.edu.cn' });
  server.replies = [];
  server.urls = [];
  server.statuses = [];
  server.beforeResponse = undefined;
});
const identity = { code: '0', result: { user: { code: 'test-user' } } };

it('shares simultaneous identity checks without caching the login result across later calls', async () => {
  server.replies = [identity, identity];
  await Promise.all([checkVideoLogin(), checkVideoLogin()]);
  expect(server.urls).toHaveLength(1);
  await checkVideoLogin();
  expect(server.urls).toHaveLength(2);
});

it('retries a temporary API failure but does not retry an expired session', async () => {
  server.replies = [null, identity, []];
  server.statuses = [503, 200, 200];
  expect(await listCourses()).toEqual([]);
  expect(server.urls[0]).toBe(server.urls[1]);
  server.replies = [null];
  server.statuses = [401];
  await expect(checkVideoLogin()).rejects.toThrow('登录');
  expect(server.urls).toHaveLength(4);
});

it('checks login before interpreting an empty curriculum as no courses', async () => {
  server.replies = [{ code: '-1', result: null }];
  await expect(listCourses()).rejects.toThrow('登录');
  expect(server.urls).toHaveLength(1);
});

it.each([
  [{ status: 200, result: [{ id: 11, currentTerm: true }] }],
  [[{ id: 11, currentTerm: true }]],
])(
  'discovers the current term from either official response shape and loads all pages (%j)',
  async (termResponse) => {
    server.replies = [
      identity,
      termResponse,
      {
        ok: true,
        data: {
          records: [{ teclId: 9000, subjCode: 'CS3313', subjName: '计算理论' }],
          pageCount: 2,
        },
      },
      {
        ok: true,
        data: {
          records: [
            { teclId: 9000, subjCode: 'CS3313', subjName: '计算理论' },
            { teclId: 9419, subjCode: 'CS2106', subjName: '大模型' },
          ],
          pageCount: 2,
        },
      },
    ];
    expect(await listCourses()).toEqual([
      { id: 9000, code: 'CS3313', name: '计算理论' },
      { id: 9419, code: 'CS2106', name: '大模型' },
    ]);
    const url = new URL(server.urls[3]!);
    expect(url.searchParams.get('acteId')).toBe('11');
    expect(url.searchParams.get('page.pageIndex')).toBe('2');
    expect(server.urls).toHaveLength(4);
    expect(server.urls.some((url) => url.includes('group_subject_vod_list'))).toBe(false);
  },
);

it('reports a changed page contract instead of silently returning an empty video list', async () => {
  server.replies = [identity, { ok: true, data: { unexpected: [] } }];
  await expect(listVideos(9000)).rejects.toThrow('数据');
});

describe.each(['courses', 'videos'] as const)('%s empty pages', (kind) => {
  const load = () => (kind === 'courses' ? listCourses() : listVideos(9000));
  beforeEach(() => {
    server.replies = kind === 'courses' ? [identity, [{ id: 11, currentTerm: true }]] : [identity];
  });

  it.each([null, []])('accepts a successful zero-count page with records=%j', async (records) => {
    server.replies.push({
      ok: true,
      dataOk: true,
      status: 200,
      data: { records, rowCount: 0, pageCount: 0 },
    });
    if (kind === 'courses')
      server.replies.push({
        ok: true,
        dataOk: true,
        data: { records, rowCount: 0, pageCount: 0 },
      });
    const expectedRequests = server.replies.length;
    await expect(load()).resolves.toEqual([]);
    expect(server.urls).toHaveLength(expectedRequests);
    const url = new URL(server.urls.at(-1)!);
    expect(url.pathname).toContain(
      kind === 'courses' ? 'group_subject_vod_list/t-1' : 'subject_vod_list_new',
    );
    expect(url.searchParams.get('page.pageIndex')).toBe('1');
    expect(url.searchParams.get('page.pageSize')).toBe('1000');
  });

  it.each([
    { records: null, rowCount: 1, pageCount: 0 },
    { records: null, rowCount: 0, pageCount: 1 },
    { records: null, pageCount: 0 },
    { records: null, rowCount: 0 },
    { records: null, rowCount: '0', pageCount: 0 },
    { records: null, rowCount: 0, pageCount: '0' },
    { rowCount: 0, pageCount: 0 },
    { records: {}, rowCount: 0, pageCount: 0 },
  ])('rejects incomplete or inconsistent empty data without retry (%j)', async (data) => {
    server.replies.push({ ok: true, dataOk: true, status: 200, data });
    const expectedRequests = server.replies.length;
    await expect(load()).rejects.toThrow('列表数据格式已变化');
    expect(server.urls).toHaveLength(expectedRequests);
  });

  it.each([
    [{ ok: false, dataOk: true, status: 200 }, '接口请求失败'],
    [{ ok: true, dataOk: false, status: 200 }, '接口请求失败'],
    [{ dataOk: true, status: 200 }, '列表数据格式已变化'],
    [{ ok: true, status: 200 }, '列表数据格式已变化'],
    [{ ok: true, dataOk: true, status: 401 }, '登录'],
    [{ ok: true, dataOk: true, code: '-1' }, '登录'],
  ] as const)(
    'does not treat an unconfirmed or failed response as empty (%j)',
    async (status, error) => {
      server.replies.push({ ...status, data: { records: null, rowCount: 0, pageCount: 0 } });
      const expectedRequests = server.replies.length;
      await expect(load()).rejects.toThrow(error);
      expect(server.urls).toHaveLength(expectedRequests);
    },
  );
});

describe('on-demand course fallback', () => {
  beforeEach(() => {
    server.replies = [
      identity,
      [{ id: 11, currentTerm: true }, { id: 12 }],
      { ok: true, dataOk: true, data: { records: null, rowCount: 0, pageCount: 0 } },
    ];
  });

  it('paginates the official course list, filters by current term and deduplicates course IDs', async () => {
    const current = { acteId: '11', teclId: '9000', subjCode: null, subjName: '测试课程' };
    server.replies.push(
      {
        ok: true,
        dataOk: true,
        data: {
          records: [
            { ...current, acteId: 10, teclId: 8999 },
            current,
            { ...current, acteId: 12, teclId: 9001 },
          ],
          pageCount: 2,
        },
      },
      {
        ok: true,
        dataOk: true,
        data: { records: [current, { ...current, teclId: 9002, subjCode: 'TEST' }], pageCount: 2 },
      },
    );
    await expect(listCourses()).resolves.toEqual([
      { id: 9000, code: '', name: '测试课程' },
      { id: 9002, code: 'TEST', name: '测试课程' },
    ]);
    expect(server.urls).toHaveLength(5);
    for (const [index, value] of server.urls.slice(3).entries()) {
      const url = new URL(value);
      expect(url.pathname).toBe('/jy-application-resourcemanage/v1/group_subject_vod_list/t-1');
      expect(url.searchParams.get('page.pageIndex')).toBe(String(index + 1));
      expect(url.searchParams.get('page.pageSize')).toBe('1000');
      expect(url.searchParams.get('page.orders[0].asc')).toBe('false');
      expect(url.searchParams.get('page.orders[0].field')).toBe('courBeginTime');
    }
  });

  it('returns no courses when on-demand courses belong only to older terms', async () => {
    server.replies.push({
      ok: true,
      data: { records: [{ acteId: 10, teclId: 9000, subjName: '旧课程' }], pageCount: 1 },
    });
    await expect(listCourses()).resolves.toEqual([]);
  });

  it.each([
    { teclId: 9000, subjName: '缺少学期' },
    { acteId: null, teclId: 9000, subjName: '无效学期' },
    { acteId: 11, teclId: 'invalid', subjName: '无效课程编号' },
    { acteId: 11, teclId: 9000 },
  ])('rejects incomplete on-demand course metadata (%j)', async (course) => {
    server.replies.push({ ok: true, data: { records: [course], pageCount: 1 } });
    await expect(listCourses()).rejects.toThrow('数据格式已变化');
  });

  it.each([
    [{ ok: false, data: { records: [] } }, '接口请求失败'],
    [{ ok: true, dataOk: false, data: { records: [] } }, '接口请求失败'],
    [{ code: '-1', data: null }, '登录'],
    [{ ok: true, data: { unexpected: [] } }, '列表数据格式已变化'],
  ] as const)(
    'reports fallback errors instead of presenting an empty list (%j)',
    async (reply, error) => {
      server.replies.push(reply);
      await expect(listCourses()).rejects.toThrow(error);
      expect(server.urls).toHaveLength(4);
    },
  );

  it.each([
    { ok: false, data: { records: [], pageCount: 0 } },
    { ok: true, dataOk: false, data: { records: [], pageCount: 0 } },
  ])(
    'does not fall back after the curriculum reports failure with an empty array (%j)',
    async (reply) => {
      server.replies[2] = reply;
      await expect(listCourses()).rejects.toThrow('接口请求失败');
      expect(server.urls).toHaveLength(3);
    },
  );
});

it('preserves video pagination, query parameters and field mapping', async () => {
  const video = {
    id: 12,
    courBeginTime: '2026-10-16 08:00:00',
    courEndTime: '2026-10-16 08:45:00',
  };
  server.replies = [
    identity,
    { ok: true, data: { records: [{ ...video, clroName: '教室', letiNumber: 1 }], pageCount: 2 } },
    {
      ok: true,
      data: { records: [{ ...video, id: 13, clroName: null, letiNumber: null }], pageCount: 2 },
    },
  ];
  await expect(listVideos(9000)).resolves.toEqual([
    { id: 12, start: video.courBeginTime, end: video.courEndTime, room: '教室', period: '1' },
    { id: 13, start: video.courBeginTime, end: video.courEndTime, room: '', period: '' },
  ]);
  expect(server.urls).toHaveLength(3);
  const query = new URL(server.urls[2]!).searchParams;
  expect(query.get('teclIds')).toBe('9000');
  expect(query.get('page.pageIndex')).toBe('2');
  expect(query.get('page.orders[0].asc')).toBe('false');
  expect(query.get('page.orders[0].field')).toBe('courBeginTime');
});

it('does not discard earlier pages when a later page unexpectedly reports zero total records', async () => {
  server.replies = [
    identity,
    { ok: true, data: { records: [{ id: 12 }], pageCount: 2 } },
    { ok: true, dataOk: true, data: { records: null, rowCount: 0, pageCount: 0 } },
  ];
  await expect(listVideos(9000)).rejects.toThrow('列表数据格式已变化');
  expect(server.urls).toHaveLength(3);
});

it('rejects missing streams without guessing the cause and retains validation details', () => {
  expect(() => parseStreams({ courseVodViewList: null })).toThrow(
    expect.objectContaining({
      message: '暂未获取到可播放录像，请稍后重试',
      cause: expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ['courseVodViewList'], code: 'invalid_type' }),
        ]),
      }),
    }),
  );
});

it('keeps both valid streams and rejects links outside the known media host', () => {
  const streams = parseStreams({
    courseVodViewList: [
      { url: 'https://live.sjtu.edu.cn/a.mp4?key=test', viewNum: 1, vodTime: 3308 },
      { url: 'https://live.sjtu.edu.cn/b.mp4?key=test', viewNum: 5, vodTime: 3309 },
    ],
  });
  expect(streams.map(({ view, duration }) => ({ view, duration }))).toEqual([
    { view: 1, duration: 3308 },
    { view: 5, duration: 3309 },
  ]);
  expect(() =>
    parseStreams({ courseVodViewList: [{ url: 'https://example.com/a.mp4', viewNum: 1 }] }),
  ).toThrow('地址');
});

describe('short-lived list snapshots', () => {
  const terms = [{ id: 11, currentTerm: true }];
  const coursePage = (name = '测试课程') => ({
    ok: true,
    data: { records: [{ teclId: 9000, subjCode: 'TEST', subjName: name }], pageCount: 1 },
  });
  const videoPage = (videoId = 12) => ({
    ok: true,
    data: {
      records: [
        { id: videoId, courBeginTime: '2026-10-16 08:00', courEndTime: '2026-10-16 08:45' },
      ],
      pageCount: 1,
    },
  });

  it('reuses current-term courses after checking login and isolates caller mutations', async () => {
    server.replies = [identity, terms, coursePage(), identity];
    const courses = await listCourses();
    courses[0]!.name = 'caller changed';
    expect(await listCourses()).toEqual([{ id: 9000, code: 'TEST', name: '测试课程' }]);
    expect(server.urls).toHaveLength(4);
    expect(server.urls.at(-1)).toContain('/authority/me');
  });

  it('deduplicates complete course loads in addition to individual page requests', async () => {
    server.replies = [identity, terms, coursePage()];
    const [first, second] = await Promise.all([listCourses(), listCourses()]);
    expect(first).toEqual(second);
    expect(server.urls).toHaveLength(3);
    first[0]!.name = 'changed';
    expect(second[0]!.name).toBe('测试课程');
  });

  it('reuses video lists per course and keeps concurrent results independent', async () => {
    server.replies = [identity, videoPage(), identity, identity, videoPage(13)];
    const [first, second] = await Promise.all([listVideos(9000), listVideos(9000)]);
    expect(first).toEqual(second);
    first[0]!.room = 'caller changed';
    expect(second[0]!.room).toBe('');
    expect((await listVideos(9000))[0]!.id).toBe(12);
    expect((await listVideos(9001))[0]!.id).toBe(13);
    expect(server.urls).toHaveLength(5);
  });

  it('reloads after the one-minute snapshot expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      server.replies = [identity, videoPage(), identity, identity, videoPage(13)];
      await listVideos(9000);
      now.mockReturnValue(1_059_999);
      expect((await listVideos(9000))[0]!.id).toBe(12);
      now.mockReturnValue(1_060_001);
      expect((await listVideos(9000))[0]!.id).toBe(13);
      expect(server.urls).toHaveLength(5);
    } finally {
      now.mockRestore();
    }
  });

  it('does not retain a failed list load and retries normally on the next call', async () => {
    server.replies = [identity, { ok: true, data: { unexpected: [] } }, identity, videoPage()];
    await expect(listVideos(9000)).rejects.toThrow('数据格式已变化');
    expect((await listVideos(9000))[0]!.id).toBe(12);
    expect(server.urls).toHaveLength(4);
  });

  it('clears previous snapshots after an expired login instead of returning stale data', async () => {
    server.replies = [identity, videoPage(), { code: '-1', result: null }, identity, videoPage(13)];
    await listVideos(9000);
    await expect(listVideos(9000)).rejects.toThrow('登录');
    expect((await listVideos(9000))[0]!.id).toBe(13);
    expect(server.urls).toHaveLength(5);
  });

  it('invalidates both course and video snapshots when campus login cookies change', async () => {
    server.replies = [identity, terms, coursePage(), identity, videoPage()];
    await listCourses();
    await listVideos(9000);
    server.cookieChange?.({}, { domain: '.sjtu.edu.cn' });
    server.replies = [
      { code: '0', result: { user: { code: 'another-user' } } },
      terms,
      coursePage('新账号课程'),
      identity,
      videoPage(13),
    ];
    expect((await listCourses())[0]!.name).toBe('新账号课程');
    expect((await listVideos(9000))[0]!.id).toBe(13);
    expect(server.urls).toHaveLength(10);
  });

  it('keeps snapshots for unrelated cookies', async () => {
    server.replies = [identity, videoPage(), identity];
    await listVideos(9000);
    server.cookieChange?.({}, { domain: 'mail.sjtu.edu.cn' });
    expect((await listVideos(9000))[0]!.id).toBe(12);
    expect(server.urls).toHaveLength(3);
  });

  it('does not return or retain an old account response that finishes after login changes', async () => {
    server.replies = [identity, videoPage(), identity, videoPage(13)];
    server.beforeResponse = (url) => {
      if (!url.includes('subject_vod_list_new')) return;
      server.beforeResponse = undefined;
      server.cookieChange?.({}, { domain: 'v.sjtu.edu.cn' });
    };
    await expect(listVideos(9000)).rejects.toThrow('登录');
    expect((await listVideos(9000))[0]!.id).toBe(13);
    expect(server.urls).toHaveLength(4);
  });
});
