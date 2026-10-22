---
title: "Cloudflare + MailChannels 使用 DKIM 发送电子邮件"
date: 2024-07-05T07:55:21.943Z
lastmod: 2024-07-05T08:25:45.946Z
description: "独立开发者必看，cloudflare worker 其实也能发邮件，而且是比较优雅地发邮件  https://web.okjike.com/originalPost/65203d2205145f31e56e0707 什么是 DKIM ？https://www.cloudflare.com/zh-cn/learning/dns/dns-records/dns-dkim-record/  参考1"
categories:
  - "技术"
  - "开发"
tags:
  - "Cloudflare"
  - "电子邮件"
url: "/2024/07/05/Cloudflare + MailChannels 使用 DKIM 发送电子邮件/"
draft: false
---

> 独立开发者必看，cloudflare worker 其实也能发邮件，而且是比较优雅地发邮件

[https://web.okjike.com/originalPost/65203d2205145f31e56e0707](https://web.okjike.com/originalPost/65203d2205145f31e56e0707)

### 什么是 DKIM ？

[https://www.cloudflare.com/zh-cn/learning/dns/dns-records/dns-dkim-record/](https://www.cloudflare.com/zh-cn/learning/dns/dns-records/dns-dkim-record/)

-   参考1
    
    Cloudflare Email Routing 免费邮件发送服务
    
    [https://eleduck.com/posts/4lfxE0](https://eleduck.com/posts/4lfxE0)
    
-   参考2
    
    Cloudflare Email Routing 免费邮件发送（作为 Service 服务）用于 Workers/Pages 项目中。****
    
    [https://github.com/willin/cloudflare-send-email-service](https://github.com/willin/cloudflare-send-email-service)
    
-   参考3
    
    **Cloudflare + MailChannels 使用 DKIM 发送电子邮件**
    
    [https://github.com/r0n9/mail](https://github.com/r0n9/mail)
    

### 终于搞定！！！记录一下步骤，如下：

#### 1. CloudFlare 添加域名 `yourdomain.com`

#### 2. 启用Email路由：

```
[Enable Email Routing · Cloudflare Email Routing docs](https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/)
```

#### 3. 本地安装 `wrangler` 以部署 cf worker。注意 node 版本。

```jsx
sudo npm install wrangler@latest -g
```

在开始之前，请确保按照此处的说明设置 Wrangler。 [here](https://developers.cloudflare.com/workers/wrangler/get-started/)

#### 4. 生成私钥 **Generate the Private Key**

```jsx
openssl genrsa 2048 | tee priv_key.pem | openssl rsa -outform der | openssl base64 -A | wrangler secret put DKIM_PRIVATE_KEY
```

此命令的各个部分： - `openssl genrsa 2048` 生成 2048 位 RSA 密钥 - `tee priv_key.pem` 将密钥写入 `priv_key.pem` 文件 - `openssl rsa -outform der | openssl base 64 -A` 将密钥从 PEM 格式转换为 DER 格式，然后对其进行 base64 编码（这实质上是从 PEM 格式的密钥中删除标头） - `wrangler secret put DKIM_PRIVATE_KEY` 将它作为秘密添加到我们的 Cloudflare Worker 中

#### 5. CloudFalare DNS 管理页面，创建 4 个 DNS TXT 记录

![Untitled](/images/dkim3.png)

- 创建第一个 `TXT` 解析记录 运行以下命令，这将从私钥 `priv_key.pem` 创建一个公钥，编码为 base64，最后将其写入 `record.txt` 文件。

```bash
echo -n "v=DKIM1;p=" > record.txt && openssl rsa -in priv_key.pem -pubout -outform der | openssl base64 -A >> record.txt
```

复制 `record.txt` 文件的内容，并将其作为 `TXT` 记录添加到您的域中。
    - Name: `mailchannels._domainkey` ![Untitled](/images/dkim2.png)

- 创建第二个 `TXT` 解析记录
    - Name: `yourdomain.com`
    - Value: `v=spf1 a mx include:relay.mailchannels.net ~all` - 创建第三个 `TXT` 解析记录，设置`cfid`，否则会报无权限调用。 参考：[**Secure your domain name against spoofing with Domain Lockdown™**](https://support.mailchannels.com/hc/en-us/articles/16918954360845-Secure-your-domain-name-against-spoofing-with-Domain-Lockdown-)
    - Name: `_mailchannels.yourdomain.com`
    - Value: `v=mc1 cfid=yourdomain.workers.dev` > `cfid` 会在你测试的报错信息中看到，注意不是workder全url，而是子域名。解析后等待生效大约需要半天 > - 创建第四个 `TXT` 解析记录，`DMARC` 记录来强制使用DKIM签名 参考：[**Adding a DKIM Signature**](https://support.mailchannels.com/hc/en-us/articles/7122849237389-Adding-a-DKIM-Signature)
    - Name: `_dmarc.yourdomain.com`
    - Value: `v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:YYY; ruf=mailto:YYY pct=100; fo=1;`

#### 6. 验证DKIM解析，有可能需要等待几个小时，DNS 记录才会更新。 [https://dmarcly.com/tools/dkim-record-checker](https://dmarcly.com/tools/dkim-record-checker)

正常显示如下： ![dkim1](/images/dkim1.png)

#### 7. 代码解压，wrangler 部署到 cf worker

[cloudflare-send-email-service.zip](/images/cloudflare-send-email-service.zip)

```bash
wrangler deploy --name mail
```

#### 8. 验证，邮件发送成功，返回状态码 `202`

```bash
curl --location 'https://mail.yourdomain.workers.dev' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'sender_email=admin@yourdomain.com' \
--data-urlencode 'sender_name=xxx' \
--data-urlencode 'recipient_email=xxx@gmail.com' \
--data-urlencode 'subject=测试' \
--data-urlencode 'message=111' \
--data-urlencode 'recipient_name=user'
```
