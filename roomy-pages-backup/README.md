# Roomy Pages Backup Service

This is a simple service that will watch a roomy space and replicate all of it's pages to a git
repo.

This is great if you want to keep a git backup of all of your roomy pages.

When started it will backfill any page history that already exists and then begin listening for any
updated pages in realtime. Every time you save a page, it will sync the edit straight to git!

You can easily run the service as a docker container with docker-compose:

```yaml
service:
  pages-backup:
    image: ghcr.io/muni-town/roomy-pages-backup:main
    restart: unless-stopped
    environment:
      ATPROTO_USERNAME: example.bsky.social
      ATPROTO_APP_PASSWORD: super-secret-password
      ROOMY_SPACE: 3ca009c672155ac4a5f95faf2c587dc8f2e17f40790ce1ce540e2f53dacd6214
      GIT_REMOTE: git@github.com:muni-town/muni-town-roomy-pages-backup.git
      GIT_EMAIL: example@email.com
      GIT_NAME: example
    volumes:
      - data:/project/git
    configs:
      - source: ssh-key
        target: /root/.ssh/id_ed25519
        mode: 0400

configs:
  ssh-key:
    content: |
      -----BEGIN OPENSSH PRIVATE KEY-----
      b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
      QyNTUxOQAAACB9gvjrlxns6Mc+LYwiTWH5KxyB+twxIIhEa8nw5nC2xQAAAJjLNodwyzaH
      cAAAAAtzc2gtZWQyNTUxOQAAACB9gvjrlxns6Mc+LYwiTWH5KxyB+twxIIhEa8nw5nC2xQ
      AAAEATs5p9lWRCtL789uV5o2ntX/DS1d4NBIm79I+tykbJgn2C+OuXGezoxz4tjCJNYfkr
      HIH63DEgiERryfDmcLbFAAAADnppY2tsYWdAcG9wLW9zAQIDBAUGBw==
      -----END OPENSSH PRIVATE KEY-----

volumes:
  data:
```

