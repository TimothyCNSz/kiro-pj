# test/

测试支撑目录。

存放跨模块的集成/冒烟测试与共享测试工具（fixtures、生成器、SES/S3 替身桩）。
单元测试与属性化测试（fast-check）可与源码就近放置（`*.test.ts`）。

运行方式：`npm test`（等价 `vitest --run`，单次执行）。
