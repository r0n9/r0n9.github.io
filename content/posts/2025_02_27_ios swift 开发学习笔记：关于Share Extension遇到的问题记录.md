---
title: "iOS swift 开发学习笔记：关于Share Extension遇到的问题记录"
date: 2025-02-27T01:49:23.998Z
lastmod: 2025-02-27T02:53:28.233Z
description: "Share Extension 分享扩展在项目中添加新的 Share Extension target NSExtensionActivationRule扩展的 Info.plist 123456789101112<key>NSExtensionAttributes</key><dict>    <key>NSExtensionActivationR"
categories:
  - "技术"
  - "开发"
tags:
  - "iOS"
  - "swift"
  - "app"
url: "/2025/02/27/ios swift 开发学习笔记：关于Share Extension遇到的问题记录/"
draft: false
---

## Share Extension 分享扩展

在项目中添加新的 Share Extension target  
![Share Extension](/images/%E6%88%AA%E5%B1%8F2025-02-27.09.53.01.png)

## NSExtensionActivationRule

扩展的 Info.plist

```plaintext
<key>NSExtensionAttributes</key>
<dict>
    <key>NSExtensionActivationRule</key>
    <dict>
        <key>NSExtensionActivationSupportsText</key>
        <true/>
        <key>NSExtensionActivationSupportsImageWithMaxCount</key>
        <integer>9</integer>
        <key>NSExtensionActivationSupportsWebURLWithMaxCount</key>
        <integer>1</integer>
    </dict>
</dict>
```

## Share Extension 分享扩展，分享发布后直接跳转主应用APP

class ShareViewController: SLComposeServiceViewController

didSelectPost 方法实现，点击默认的发布按钮后的处理  
![Share Extension](/images/share_ext1.jpeg)

原本打算尝试点击发布后，打开主应用app，这里一直失败。  
主应用URL设置，涉及 `URL Types` in `Info.plist`，这里不展开。  
排除了主应用的URL错误，尝试在safari中输入url，例如”testProject://“，可以打开主应用。

通过URL打开应用代码，直接使用extension的open方法：

```plaintext
if let url = URL(string: "testProject://") {
    print("URL: \(url)")
    self.extensionContext?.open(url) { success in
        print("URL \(success ? "opened" : "failed to open")")
        self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
} else {
    print("URL 格式错误")
    return
}
```

问题原因：  
[https://stackoverflow.com/questions/24297273/openurl-not-work-in-action-extension](https://stackoverflow.com/questions/24297273/openurl-not-work-in-action-extension)

> NSExtensionContext only support openURL function in today extension ,this is described in apple’s documents about NSExtensionContext.The original words is “Each extension point determines whether to support this method, or under which conditions to support this method. In iOS 8.0, only the Today extension point supports this method.”

译: 在 iOS 中，NSExtensionContext 的 openURL:completionHandler: 方法仅在 Today 扩展中可用。 根据苹果官方文档的描述：“每个扩展点决定是否支持此方法，或在何种条件下支持此方法。在 iOS 8.0 中，只有 Today 扩展点支持此方法。” 这意味着，除 Today 扩展外，其他类型的扩展（如 Share、Action 等）无法使用 openURL:completionHandler: 方法来打开 URL。 因此，您需要根据扩展的类型，选择适合的方式来处理 URL 打开操作。

因此，想通过扩展组件，直接打开某个APP，应该是做不到了，出于安全考虑吧。

参考了一下其他APP的做法，有大致思路了：

**放弃在分享发布后打开主应用APP，在 Share Extension 中直接实现功能，也就是修改 Share Extension 中默认的分享页面实现。**

## 使用 App Group 通过 UserDefaults 实现数据共享

为了在主App和Share Extension之间共享数据，需要启用 App Groups：

-   在Xcode中，选择主App和Share Extension的Target。
-   在 Signing & Capabilities 中，点击 “+” 添加 App Groups。
-   设置一个唯一的App Group ID，例如group.com.yourcompany.app，并在两个Target中启用。
