"""
title: Wan 2.7 Image - Token Plan
author: wecom-openwebui-bridge contributors
version: 1.5.0
description: 使用阿里云百炼 Token Plan 生成图片并缓存到当前用户的 Open WebUI 文件空间
"""

import base64
import json
from typing import Literal

import httpx
from pydantic import BaseModel, Field


class Tools:
    TOOL_VERSION = "1.5.0"

    class Valves(BaseModel):
        TOKEN_PLAN_API_KEY: str = Field(
            default="",
            description="Token Plan 专属 API Key，应以 sk-sp- 开头",
            json_schema_extra={"input": {"type": "password"}},
        )
        API_URL: str = Field(
            default=(
                "https://token-plan.cn-beijing.maas.aliyuncs.com/"
                "api/v1/services/aigc/multimodal-generation/generation"
            ),
            description="Token Plan 多模态生成接口，请不要填写普通 DashScope 地址",
        )
        MODEL_ID: Literal["wan2.7-image", "wan2.7-image-pro"] = Field(
            default="wan2.7-image",
            description="图片生成模型；pro 质量和最高分辨率更高",
        )
        DEFAULT_SIZE: Literal["1K", "2K", "4K"] = Field(
            default="2K",
            description="默认输出规格；wan2.7-image 不支持 4K",
        )
        IMAGE_COUNT: int = Field(
            default=1,
            ge=1,
            le=4,
            description="每次生成图片数量，取值范围 1 到 4，数量会影响 Credits 消耗",
        )
        WATERMARK: bool = Field(
            default=False,
            description="是否添加平台水印",
        )
        THINKING_MODE: bool = Field(
            default=True,
            description="是否开启思考模式；可能提升质量，但会增加生成时间",
        )
        TIMEOUT_SECONDS: int = Field(
            default=300,
            ge=30,
            le=600,
            description="等待图片生成的最长时间，单位为秒",
        )

    def __init__(self):
        self.valves = self.Valves()

    async def generate_wan_image(
        self,
        prompt: str,
        __event_emitter__: callable = None,
        __chat_id__: str = None,
        __message_id__: str = None,
        __metadata__: dict = None,
        __request__=None,
        __user__: dict = None,
    ) -> str:
        """
        使用 Wan 2.7 根据文字描述生成图片。
        :param prompt: 对目标图片的完整中文或英文描述
        :return: 生成结果和可直接显示的图片链接
        """
        api_key = self.valves.TOKEN_PLAN_API_KEY.strip()
        if not api_key:
            return "生成失败：请先在工具 Valves 中填写 TOKEN_PLAN_API_KEY。"

        if not api_key.startswith("sk-sp-"):
            return "生成失败：这里需要使用以 sk-sp- 开头的 Token Plan 专属 API Key。"

        prompt = (prompt or "").strip()
        if not prompt:
            return "生成失败：prompt 不能为空。"

        if (
            self.valves.MODEL_ID == "wan2.7-image"
            and self.valves.DEFAULT_SIZE == "4K"
        ):
            return "生成失败：wan2.7-image 最高支持 2K；4K 请改用 wan2.7-image-pro。"

        payload = {
            "model": self.valves.MODEL_ID,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [{"text": prompt}],
                    }
                ]
            },
            "parameters": {
                "size": self.valves.DEFAULT_SIZE,
                "n": self.valves.IMAGE_COUNT,
                "watermark": self.valves.WATERMARK,
                "thinking_mode": self.valves.THINKING_MODE,
            },
        }

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        try:
            timeout = httpx.Timeout(self.valves.TIMEOUT_SECONDS)
            async with httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = await client.post(
                    self.valves.API_URL,
                    headers=headers,
                    json=payload,
                )

            try:
                result = response.json()
            except ValueError:
                result = {"raw_response": response.text[:2000]}

            if response.status_code < 200 or response.status_code >= 300:
                message = result.get("message") if isinstance(result, dict) else None
                code = result.get("code") if isinstance(result, dict) else None
                return (
                    f"生成失败：HTTP {response.status_code}，"
                    f"code={code or 'unknown'}，"
                    f"message={message or str(result)[:1000]}"
                )

            output = result.get("output", {}) if isinstance(result, dict) else {}
            choices = output.get("choices") or []
            image_urls = []

            for choice in choices:
                message = choice.get("message", {})
                for content in message.get("content") or []:
                    if content.get("type") == "image" and content.get("image"):
                        image_urls.append(content["image"])

            if not image_urls:
                return (
                    "生成请求已返回，但没有找到图片 URL。原始响应：\n"
                    + json.dumps(result, ensure_ascii=False)[:4000]
                )

            metadata = __metadata__ or {}

            # Download the short-lived OSS result on the server and save it as
            # a file owned by the current Open WebUI user. The browser and API
            # client then read a stable local /api/v1/files/... URL instead of
            # contacting Aliyun directly.
            display_urls = []
            cache_errors = []
            if __request__ is not None and (__user__ or {}).get("id"):
                try:
                    from open_webui.models.users import Users
                    from open_webui.utils.files import get_image_url_from_base64

                    current_user = await Users.get_user_by_id(__user__["id"])
                    if current_user is None:
                        raise RuntimeError("current Open WebUI user was not found")

                    async with httpx.AsyncClient(
                        timeout=httpx.Timeout(120),
                        follow_redirects=False,
                        trust_env=False,
                    ) as image_client:
                        for image_url in image_urls:
                            image_response = await image_client.get(image_url)
                            if image_response.status_code < 200 or image_response.status_code >= 300:
                                raise RuntimeError(
                                    f"OSS image download HTTP {image_response.status_code}"
                                )
                            image_bytes = image_response.content
                            if not image_bytes:
                                raise RuntimeError("OSS image download returned empty content")
                            if len(image_bytes) > 25 * 1024 * 1024:
                                raise RuntimeError("generated image exceeds 25 MB cache limit")

                            content_type = (
                                image_response.headers.get("content-type", "image/png")
                                .split(";", 1)[0]
                                .strip()
                            )
                            if not content_type.startswith("image/"):
                                content_type = "image/png"
                            data_url = (
                                f"data:{content_type};base64,"
                                + base64.b64encode(image_bytes).decode("ascii")
                            )
                            stored_url = await get_image_url_from_base64(
                                __request__,
                                data_url,
                                metadata,
                                current_user,
                            )
                            if not stored_url:
                                raise RuntimeError("Open WebUI file cache returned no URL")
                            display_urls.append(stored_url)
                except Exception as cache_error:
                    cache_errors.append(
                        f"{type(cache_error).__name__}:{str(cache_error)[:300]}"
                    )

            if len(display_urls) != len(image_urls):
                display_urls = image_urls
                cache_status = (
                    "failed:" + " | ".join(cache_errors)
                    if cache_errors
                    else "skipped:no-request-or-user-context"
                )
            else:
                cache_status = f"ok:{len(display_urls)}"

            image_files = [
                {"type": "image", "url": image_url}
                for image_url in display_urls
            ]

            # Persist exactly as Open WebUI's official built-in image tool does.
            # Metadata is kept as a fallback for versions that do not inject the
            # dedicated __chat_id__ / __message_id__ arguments.
            chat_id = __chat_id__ or metadata.get("chat_id")
            message_id = __message_id__ or metadata.get("message_id")
            persistence_status = "skipped:no-chat-context"
            if chat_id and message_id:
                try:
                    from open_webui.models.chats import Chats

                    db_files = await Chats.add_message_files_by_id_and_message_id(
                        chat_id,
                        message_id,
                        image_files,
                    )
                    if db_files is not None:
                        image_files = db_files
                        persistence_status = "ok"
                    else:
                        persistence_status = "failed:db-returned-none"
                except Exception as persistence_error:
                    persistence_status = (
                        "failed:"
                        f"{type(persistence_error).__name__}:"
                        f"{str(persistence_error)[:300]}"
                    )

            # Also emit to a connected Open WebUI browser when present.
            if __event_emitter__:
                try:
                    # Short form is persisted by newer Open WebUI versions.
                    await __event_emitter__(
                        {
                            "type": "files",
                            "data": {"files": image_files},
                        }
                    )
                    # Long form updates an actively connected browser.
                    await __event_emitter__(
                        {
                            "type": "chat:message:files",
                            "data": {"files": image_files},
                        }
                    )
                except Exception:
                    # Image generation succeeded even if this Open WebUI version
                    # does not support the file event; the marker below remains.
                    pass

            lines = [
                f"已使用 {self.valves.MODEL_ID} 生成 {len(image_urls)} 张图片。",
                "图片已经保存并附加到当前 Open WebUI 消息。",
                "无需在正文中再次展示或改写图片链接。",
                (
                    "系统集成要求：最终回答必须原样保留每一行 WAN_ 开头的"
                    "机器标记，不得改写或省略。"
                ),
                f"WAN_TOOL_VERSION:{self.TOOL_VERSION}",
                f"WAN_LOCAL_CACHE:{cache_status}",
                f"WAN_DB_PERSIST:{persistence_status}",
            ]

            for index, image_url in enumerate(display_urls, start=1):
                encoded_url = base64.urlsafe_b64encode(
                    image_url.encode("utf-8")
                ).decode("ascii")
                lines.append(f"\n图片 {index} 机器标记：")
                lines.append(f"WAN_IMAGE_URL_B64:{encoded_url}")

            return "\n".join(lines)

        except httpx.TimeoutException:
            return (
                "生成失败：请求超时。可在 Valves 中增大 TIMEOUT_SECONDS，"
                "并确认服务器能够访问 token-plan.cn-beijing.maas.aliyuncs.com。"
            )
        except httpx.RequestError as error:
            return f"生成失败：网络请求异常：{type(error).__name__}: {error}"
        except Exception as error:
            return f"生成失败：{type(error).__name__}: {error}"

