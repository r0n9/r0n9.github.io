---
title: "Firewalld防火墙的规则无法控制Docker端口的问题"
date: 2024-10-10T06:42:57.663Z
lastmod: 2024-10-10T06:44:59.811Z
description: "在 Ubuntu 系统中使用 firewalld 时，默认情况下，firewalld 不会对 Docker 容器的网络流量生效。这是因为 Docker 在启动时会自动创建自己的 iptables 规则来管理网络，绕过了 firewalld 的规则。这种行为可以确保 Docker 容器的网络功能正常，但也会导致 firewalld 的规则无法控制 Docker 端口。 具体原因有以下几点： 1. D"
categories:
  - "技术"
tags:
  - "docker"
  - "ubuntu"
  - "firewalld"
url: "/2024/10/10/Firewalld防火墙的规则无法控制Docker端口的问题/"
draft: false
---

在 Ubuntu 系统中使用 `firewalld` 时，默认情况下，`firewalld` 不会对 Docker 容器的网络流量生效。这是因为 Docker 在启动时会自动创建自己的 `iptables` 规则来管理网络，绕过了 `firewalld` 的规则。这种行为可以确保 Docker 容器的网络功能正常，但也会导致 `firewalld` 的规则无法控制 Docker 端口。

具体原因有以下几点：

### 1. Docker 使用 `iptables`

Docker 默认会直接操作 `iptables` 来管理网络连接，而不是通过 `firewalld`。因此，`firewalld` 中的规则不会影响 Docker 创建的容器的网络流量。

### 2. Docker 配置覆盖 `firewalld`

Docker 会修改 `iptables` 规则，以确保容器能够进行网络连接和端口转发。这些规则可能与 `firewalld` 的设置发生冲突，导致 `firewalld` 对 Docker 的流量无效。

### 解决方案

如果你希望 `firewalld` 可以控制 Docker 容器的网络流量，可以尝试以下几种方法。

#### 方法 1: 配置 Docker 使用 `firewalld` 管理规则

可以通过修改 Docker 的配置，禁用 Docker 自己管理 `iptables`，让 `firewalld` 接管。

1.  打开 Docker 配置文件（如果文件不存在，可以新建一个）：
    
    ```bash
    sudo nano /etc/docker/daemon.json
    ```
    
2.  添加以下配置，禁用 Docker 自动修改 `iptables`：
    
    ```json
    {
      "iptables": false
    }
    ```
    
3.  重启 Docker 服务：
    
    ```bash
    sudo systemctl restart docker
    ```
    

通过禁用 Docker 的 `iptables` 规则，网络流量将由 `firewalld` 进行控制。

> 注意：禁用 `iptables` 后，你需要手动管理网络规则，确保容器仍然可以正常访问外部网络。

#### 方法 2: 使用 `iptables` 自定义规则

如果你不希望禁用 Docker 的 `iptables` 管理，你可以通过手动添加 `iptables` 规则来配合 `firewalld`。

1.  确认 Docker 的网络桥接接口（通常是 `docker0`）：
    
    ```bash
    ifconfig
    ```
    
2.  在 `firewalld` 中允许或限制该接口的流量。例如：
    
    ```bash
    sudo firewall-cmd --zone=trusted --add-interface=docker0 --permanent
    sudo firewall-cmd --reload
    ```
    

这样可以将 `docker0` 接口添加到 `firewalld` 的 `trusted` 区域，允许其网络流量。

### 总结

`firewalld` 对 Docker 容器的端口没有生效，是因为 Docker 默认直接操作 `iptables`，绕过了 `firewalld` 的规则。你可以通过禁用 Docker 的 `iptables` 管理功能，或手动配置 `iptables` 来使 `firewalld` 生效。
