FROM denoland/deno:2.7.5

RUN mkdir /project
COPY ./* /project/
WORKDIR /project

CMD ["run", "--allow-net", "main.ts"]
