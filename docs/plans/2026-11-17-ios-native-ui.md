# iOS 用系统原生界面

- 日期：2026-11-17
- 状态：第一轮完成（只在 fork 里），模拟器上验过
- 相关：[iOS 版手机 App](2026-11-17-ios-app.md)、[手机 App](2026-10-24-mobile-app.md)

## 为什么

`mobile/` 的界面是一套自绘的跨平台组件（抽屉、圆形按钮、自画开关和分段控件、自画导航栏），在 iOS 上看起来像网页搬过来的。iOS 26 起系统控件换成了 Liquid Glass，自绘组件跟不上，手势和无障碍也要自己补。

## 做法

**还是 React Native，同一份代码；只在 iOS 上把外壳换成系统原生组件。** Android 不变。不重写 SwiftUI App（理由见 iOS 版方案）。

用到的原生能力：

- 导航栏：`react-native-screens` 的原生 `UINavigationBar`（`headerShown`），按钮用 `unstable_headerLeftItems` / `unstable_headerRightItems`：SF Symbols 图标、iOS 26 的角标和 Liquid Glass 背景、原生 `UIMenu`。
- 列表顶上的搜索：`headerSearchBarOptions`（`UISearchController`）。
- 设置类页面：Expo UI（`@expo/ui/swift-ui`）的 `Form`、`Section`、`Toggle`、`Picker`，就是 SwiftUI 的表单。
- 图标：`expo-symbols`（SF Symbols）。
- 开关：React Native 自带的 `Switch` 就是 `UISwitch`，替换自画开关。

### 结构变化

| 地方 | 现在（两端一样） | iOS 改成 |
|---|---|---|
| 团队列表 | 左侧抽屉，从聊天里拉出来 | 根页面：大标题「DS Bot」、系统搜索栏，点一行推进聊天；左上齿轮开设置，右上「＋」是原生菜单（新建 Bot / 新建群聊） |
| 聊天页顶栏 | 自画：抽屉按钮、头像胶囊、侧聊按钮 | 原生导航栏：返回按钮回到列表，标题是头像胶囊（点开详情），右侧 SF Symbol 侧聊按钮 |
| 详情和设置子页 | 自画返回行 `BackRow` / `Back` | 原生导航栏，标题和右侧按钮不变，有系统返回手势 |
| 弹出页（设置、需要你、新建） | 自画 `SheetHeader`（把手 + 完成） | 原生导航栏，「完成」用 `done` 样式 |
| 设置首页 | 自画分组卡片、分段控件 | SwiftUI `Form`：分组、菜单式选择器、`Toggle` |
| 其他页里的开关和分段 | 自画 | `UISwitch`；分段用 SwiftUI 分段 `Picker` |

**不动的部分**：聊天气泡、Markdown、卡片、输入框、团队配色（气泡和强调色仍跟电脑上的主题走）。这些是 DS Bot 自己的内容样式，不是系统控件。

### 颜色

- 外壳（导航栏、表单）用系统颜色，跟随深浅色；强调色用团队的 accent 作为 tint。
- App 内「外观」选了浅色或深色时，iOS 上用 `Appearance.setColorScheme` 让原生控件一起切换，否则系统表单和自绘部分颜色会对不上。

### 打开上次的聊天

现在启动时直接停在上次的聊天。iOS 改成列表在下、上次的聊天推在上面，所以启动时看到的还是上次的聊天，按返回回到列表。`openChat` 的「替换当前聊天，不叠加」规则不变。

## 不做

- iOS 27 才有的接口：这台机器只有 iOS 26.5 SDK（Xcode 26.6）。升级 Xcode 以后再加。
- 消息长按菜单换成原生 `UIContextMenu`、输入框换成玻璃材质：下一轮。
- 不改 Android，不改电脑端，不进上游（改的是上游已定的界面设计，要维护者同意）。

## 验证

- `npm test`、`npm run typecheck`。
- 模拟器上：演示团队过一遍每个改过的页面，浅色和深色各一遍；连本机测试台过一遍配对后的列表、聊天、设置。

## 第一轮结果（2026-11-17，iPhone 17 Pro 模拟器，iOS 26.5）

已换成原生：

- 团队列表做根页面：大标题、iOS 26 底部搜索栏、左上设置、右上「＋」原生菜单。行改成整宽、内缩分隔线。
- 聊天页、Bot 和群详情、设置子页、记忆、日程、用量等页的顶栏：原生导航栏和返回手势，按钮是 SF Symbols，用团队强调色。
- 设置、需要你、新建 Bot、新建群聊这几个弹出页：原生栏，「完成」「创建」用 `done` 样式。
- 设置首页：SwiftUI `Form`（菜单式选择器、`Toggle`）。
- 其他页的开关换成 `UISwitch`，分段换成 SwiftUI 分段 `Picker`。权限选择器保留自绘，因为「完全访问」一项要标红，系统分段控件做不到。
- 启动时停在上次的聊天，返回是列表（用导航容器的初始状态，不靠挂载后再跳转）。
- App 内选的浅色或深色会带到原生控件上（`Appearance.setColorScheme`）。

检查：`npm test` 70 项通过、`typecheck` 通过；Android 包里没有打进 SwiftUI 模块（`.ios.tsx` 分文件）。

已知问题：

- 设置首页顶栏比下面的表单略深。改导航栏颜色、页面颜色、弹出层底色都没变化，像是 iOS 26 弹出页导航栏自己的材质，留待以后看。
- 侧聊页（`side.tsx`）还是自绘顶栏，iOS 上先关了原生栏。
- Bot 详情里的「详情 / 浏览器」切换、模型和文件夹下拉还是自绘的。
