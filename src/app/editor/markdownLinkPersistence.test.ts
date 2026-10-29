import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { FileAttachment, Image } from './Media';
import { PageLink } from './PageLink';

describe('Markdown link persistence attributes', () => {
  it('keeps stored page and file hrefs in the editor schema', () => {
    const schema = getSchema([StarterKit, PageLink, Image, FileAttachment]);
    const source = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'pageLink',
              attrs: {
                id: 'page-1',
                label: 'open the section',
                anchor: 'section',
                markdownHref: './Page.md#section',
              },
            },
          ],
        },
        {
          type: 'image',
          attrs: {
            fileId: 'image-1',
            alt: 'map',
            markdownHref: 'Attachments/Map%20one.png',
            markdownLabel: 'map link',
          },
        },
        {
          type: 'fileAttachment',
          attrs: {
            fileId: 'file-1',
            name: 'Guide.pdf',
            markdownHref: 'Attachments/Guide.pdf#page=4',
            markdownLabel: 'field guide',
          },
        },
      ],
    };

    const reopened = schema.nodeFromJSON(source).toJSON();
    expect(reopened.content?.[0]?.content?.[0]?.attrs).toMatchObject({
      markdownHref: './Page.md#section',
      anchor: 'section',
      label: 'open the section',
    });
    expect(reopened.content?.[1]?.attrs).toMatchObject({
      markdownHref: 'Attachments/Map%20one.png',
      markdownLabel: 'map link',
    });
    expect(reopened.content?.[2]?.attrs).toMatchObject({
      markdownHref: 'Attachments/Guide.pdf#page=4',
      markdownLabel: 'field guide',
    });
  });
});
