# Day 10 修复报告 · 录进去的东西看不见

> 一句话：页面**显示假数据**，但**写操作写进了真存储** —— 读写不同源，导致录入 / 勾选 / 删除全部"操作成功但结果消失"。

## 1. 今天要掌握的

**你怎么描述那个问题，让 AI 一次就改对了（或改错了）？**

## 2. 问题的原始描述（用户第一版）

> "我发现我没法进行勾删，就勾那个 DDL 或删一条，或者说是录一门课，或者录一个 DDL 我都好像都录不了。"

### 这句话哪里会误导 AI

| 用词 | AI 会理解成 | 实际是 |
|---|---|---|
| "**没法**" | 按钮点不动 / 事件没绑定 | 能点，**点完也"成功"，只是存不住** |

所以 AI 第一反应是去查 `addEventListener` —— **方向错了**。这也是本次排查中 AI 真的走过的一段弯路。

## 3. 改进后的描述（用户第二版）

> "我点了添加 DDL，点完之后发现最后点确认了还是没有显示这个 DDL，然后课程也是一样的。**但页面就是操作页面看起来正常的**，我点了它，进去也正常填了东西，**但是出来之后发现页面里面啥也没有**，也没有添加任何新的东西。而且我删那个 DDL 好像也删不掉，删课程我也删不掉……点那个删掉按钮它都没有任何反应，**不仅删掉没有反应，点编辑它也没有反应**。"

### 为什么第二版能让 AI 一次改对

| 关键句 | 作用 |
|---|---|
| "**页面看起来正常的**" | 排除"页面崩了 / 白屏"，把搜索范围从整个页面缩到"提交之后那一段" |
| "进去也正常填了东西" | 排除"输入框坏了"，说明表单能收到输入 |
| "**出来之后发现页面里面啥也没有**" | **给出失败的时间位置**：在"确认之后、回列表之前" |
| "**而且删也是、编辑也是**" | **多个功能同时坏 = 共同点在下层**，直接指向数据层而不是某个按钮 |

### 一句话总结两者的差别

> 第一版说的是**状态**（"没法用"），第二版说的是**过程**（"点什么 → 看到什么 → 结果是什么"）。
> 状态要 AI 猜，过程 AI 能顺着走。

## 4. 根因

`app.js` 里，**读**数据和**写**数据走了两条不同的路：

```js
// 读：判断了数据源
async function loadData() {
  if (usingMock()) {
    const [courses, ddls] = await Promise.all([MockStore.listCourses(), MockStore.listDdls()]);
    return { courses, ddls };
  }
  const [courses, ddls] = await Promise.all([Store.listCourses(), Store.listDdls()]);
  return { courses, ddls };
}

// 写：一律直写 Store，从来不判断
if (editing) await Store.updateCourse(editing.id, data);
else await Store.createCourse(data);          // ← 无视 mock 开关
```

而 `mock-data.js` 里的 `MockStore` **当时只有两个"读"函数，一个写函数都没有**。

于是：

1. 页面开着 `DATA_SOURCE = 'normal'` → **显示**的是 MockStore 里写死的假数据
2. 你录一门课 → 校验通过、弹层关闭、**写进了 `store.js` 的 localStorage**
3. 重新渲染 → `loadData()` **又去读 MockStore 的假数据**（那是写死的，永远不变）
4. → **你刚录的课，蒸发**

勾选、删除、编辑，全部同一个根因。

### 为什么这个 bug 特别"阴"

| 特征 | 说明 |
|---|---|
| **不报错** | 控制台干净、没有红字、弹层正常关闭 —— 一切都像"成功" |
| **数据其实写进去了** | localStorage 里躺着你的课，只是**读的时候用的是另一个源** |
| **表现像"按钮坏了"** | 会误导人去查事件绑定（AI 第一轮就上当了） |
| **静默** | 用户不会来投诉，只会以为是自己没点中 |

## 5. 修复

### 改了什么（2 个文件）

**`app.js`** —— 新增一个统一的数据源入口，读写都问它：

```js
function dataSource() {
  return usingMock() ? MockStore : Store;
}
```

然后把 8 处写调用 + 2 处读调用全部改成走 `dataSource()`：

| 位置 | 原来 | 现在 |
|---|---|---|
| `submitCourse` | `Store.createCourse` / `updateCourse` | `dataSource().createCourse` / `updateCourse` |
| `submitDdl` | `Store.createDdl` / `updateDdl` | `dataSource().createDdl` / `updateDdl` |
| `openEdit` | `Store.listDdls` / `listCourses` | `dataSource().listDdls` / `listCourses` |
| `removeRecord` | `Store.deleteCourse` / `deleteDdl` | `dataSource().deleteCourse` / `deleteDdl` |
| `toggleDone` | `Store.updateDdl` | `dataSource().updateDdl` |

**`mock-data.js`** —— 给 `MockStore` 补齐 6 个写函数（签名与 `store.js` **完全一致**）：
`createCourse` / `updateCourse` / `deleteCourse` / `createDdl` / `updateDdl` / `deleteDdl`

同时把它从"每次现算一份新数组"改成"**内存副本会记住改动**"：

```js
var _mem = null;
function mem() {
  var src = window.MockStore.source;      // 口径和 app.js 的 mockSource() 一致
  if (src !== 'normal') return { courses: [], ddls: [] };
  if (!_mem) _mem = { courses: buildCourses(), ddls: buildDdls() };
  return _mem;
}
```

### 改动规模的自我评价

这次**只改了必要的两个文件**，没有动 `index.html`、没有动样式、没有顺手优化别的。
符合今日清单的「一次只改一个」。

## 6. 验证

### 6.1 交互实测（真 DOM，模拟真人操作）

| 功能 | 结果 |
|---|---|
| 录课程（走 UI：点按钮 → 填表 → 提交） | ✅ 课程数 4 → 5 |
| 录 DDL | ✅ 3 → 4 |
| 勾选完成 | ✅ done 数 2 → 3 |
| 删除（含 confirm 确认） | ✅ 3 → 2 |
| 编辑（回填 + 改完写回） | ✅ 标题回填正确、总数不变、内容已更新 |
| 运行期错误 | ✅ 无 |

### 6.2 回归测试

```
node check-day8.js  →  通过 62 项，失败 3 项
```

**这 3 项失败与本次改动无关**，证据：用 `git stash` 把改动藏起来、跑**改动前**的代码，同样是这 3 项失败（62 通过 / 3 失败）。

失败原因是**日期漂移**：今天是 **9/26 周六**，而测试的第 1 周期望值是按 **9/24 周四**写死的（"周二那条进过期区、周四那条正常显示"）。假数据是"相对本周现算"的，测试断言却是绝对日期。

> 这是 `check-day8.js` 自身的一个脆弱点，值得以后修（把期望值也改成相对计算）。

### 6.3 修复过程中 AI 自己踩的两个坑（诚实记录）

| # | 坑 | 教训 |
|---|---|---|
| 1 | 探针只等 700ms 就断言"编辑没生效"，其实编辑要等 **两次 600ms 读数据**（填表前读一次、提交后再读一次），根本没走完 | **"没生效"和"还没生效"是两件事** —— 先确认等待够不够，再怀疑代码 |
| 2 | 第一版 `mem()` 缓存了**所有状态**的结果，导致测试中途把 source 改成 `normal` 后仍读到缓存的空数组 | 缓存只给 `'normal'`；其他状态是"临时演的"，不能缓存 |
| 3 | 给截图用的驱动脚本，第一轮**直接注入到了产品的 `index.html`** | 动了产品文件必须 `git diff` 复核 → 已 `git checkout -- index.html` 还原 |

### 6.4 意外发现的两个真问题（今天不改，记下来）

排查过程中还发现了 `check-day8.js` 的两个脆弱点，**今天不动**（今日清单规定一次只改一个）：

1. **日期漂移** —— 见 6.2，测试期望值写死日期，过几天就跑不过
2. **`w.MockStore.source = 'normal'` 这个改法本身不完整** —— 它只改了"对外报告的值"，
   而 `DATA_SOURCE` 这个闭包变量没变。现在 `mem()` 看的是 `MockStore.source`，所以能通；
   但这套"两个地方记着同一个状态"的设计迟早出事，值得以后统一成一个。

## 7. 截图

`docs/day10/` 下 4 张。**两张图是同一次操作、同一个位置（周三那一列）**，对比的差异只有一个：录进去的课在不在。

| 文件 | 说明 |
|---|---|
| `01-修前-桌面.png` | 录了「新媒体运营」（周三 16:00–17:40）→ **周三只有「数据结构」一门，新课没出现** |
| `02-修后-桌面.png` | 同样操作 → **周三显示「数据结构」+「新媒体运营 D210」** |
| `01-修前-手机.png` / `02-修后-手机.png` | 同上，504px 宽度下的对照 |

两张图的地址栏横幅分别标着 `localhost:8123/.shot-before/` 和 `localhost:8123/.shot-after/`，可确认是同一页面地址下的同一位置。

> 注：截图为无头浏览器输出，因此用页面顶部的横幅代替真实浏览器地址栏，
> 横幅上写了完整 URL 和本次操作说明。

## 8. 复现方法（以后自己验）

```bash
# 1. 跑回归测试
npm install jsdom          # 只需第一次
node check-day8.js

# 2. 手动复现原 bug（看假数据下能不能录入）
#    - 打开 index.html，确认 DATA_SOURCE = 'normal'
#    - 点「+ 添加课程」，填一门课，保存
#    - 修前：列表里不会出现；修后：立刻出现

# 3. 看四种状态：改 mock-data.js 顶部 DATA_SOURCE 为
#    'normal' / 'loading' / 'empty' / 'error'
```
