# ---- 阶段 1：编译二进制 ----
FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src

# 安装基础证书
RUN apk --no-cache add ca-certificates

# 复制源码
COPY go.mod ./
COPY internal/ ./internal/
COPY web/ ./web/
COPY main.go ./

# 静态编译，利用 Go 原生交叉编译特性快速构建对应架构（免 QEMU 模拟，大幅加速多架构镜像打包）
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /src/publisher .

# ---- 阶段 2：运行最小镜像 ----
FROM alpine:latest

# 安装 HTTPS 证书及常用时区数据
RUN apk --no-cache add ca-certificates tzdata
ENV TZ=Asia/Shanghai

WORKDIR /app

# 从构建阶段复制可执行文件
COPY --from=builder /src/publisher /app/publisher

EXPOSE 13133

ENTRYPOINT ["/app/publisher"]
